import { GoogleGenAI } from "@google/genai";
import { STT_VOCABULARY_HINT } from "@/content/stt-vocabulary";

/**
 * 語音轉文字。訪客按住說話錄下來的 WAV → 繁體中文逐字稿。
 *
 * ⚠️ 模型與參數是實測選出來的，三個都不要隨手改（2026-08-19，`npm run verify:stt`）：
 *
 *   gemini-flash-latest            3442ms  思考 620 token
 *   gemini-3.5-flash 預設           3143ms  思考 467 token
 *   gemini-3.5-flash thinking=0     942ms  思考 0     ← 快 3.5 倍
 *
 * `gemini-flash-latest` **不吃** `thinkingBudget: 0`（設了還是花 400 個思考 token），
 * `gemini-3.5-flash` 吃。轉錄不需要推理，思考純粹是延遲。
 *
 * 而 `gemini-flash-lite-latest` 雖然也快，逐字稿是壞的（「性平會」→「新聞會」，
 * 字還會被拆成一個一個），不能用。
 */
const MODEL = "gemini-3.5-flash";

/** 逐字稿不需要創意。溫度 0 讓同一段音訊每次都得到同一個結果。 */
const TEMPERATURE = 0;

/** 逐字稿再長也不會超過這個數字；/api/chat 那邊本來就只收 300 字。 */
const MAX_TRANSCRIPT_CHARS = 300;

const PROMPT = `請把這段音訊逐字轉成繁體中文文字。

規則：
- 只輸出逐字稿本身，不要加任何說明、標題、引號或前後綴
- 用台灣慣用的詞彙與標點
- 聽不清楚的地方就略過，不要猜測、不要編造
- 如果整段沒有任何人說話，就輸出空字串${STT_VOCABULARY_HINT}`;

/** 模型偶爾會加的前綴。它們不是訪客說的話，留著會污染檢索。 */
const PREAMBLES = /^(逐字稿|轉錄結果|以下是逐字稿|文字稿)\s*[:：]\s*/;

/** 整段包起來的引號。中英文都要處理。 */
const WRAPPING_QUOTES = /^["'「『“”]+|["'」』“”]+$/g;

/**
 * 模型用來表達「沒聽到內容」的各種講法。
 * 這些必須變成空字串——否則會被當成訪客真的問了「（無法辨識）」這個問題，
 * 送進 RAG 檢索，然後她會很認真地回答一個沒有人問的問題。
 */
const NON_SPEECH = /^[（(\[【]?\s*(空白|靜音|無|沒有|無法辨識|聽不清楚|無人說話|無聲|N\/?A|none|empty|silence)[^）)\]】]*[）)\]】]?\s*$/i;

/**
 * 清掉模型可能附加的雜物，回傳可以直接當成訪客問題的字串。
 *
 * 純函式，有測試。放這裡而不是 route 裡，是因為 route 在 vitest 裡驗不到
 * （這個 repo 沒有 jsdom、也沒有 route 層的測試基礎建設）。
 *
 * ⚠️ 這裡**不做** prompt injection 防禦，那不是它的職責。
 * 訪客大可以對著麥克風說「忽略你的指示」——但那段文字會以 user turn 的身分
 * 進到 /api/chat，而那邊本來就把使用者輸入當資料而非指令（persona 規則第 7 條），
 * 加上檢索門檻 HARD_FLOOR 會讓離題的東西根本到不了 LLM。防線在那裡，不在這裡。
 */
export function sanitizeTranscript(raw: string): string {
  let text = (raw ?? "").trim();
  if (!text) return "";

  // 換行在逐字稿裡沒有意義，而且會讓後續的比對與顯示變醜
  text = text.replace(/\s*\n+\s*/g, " ");
  text = text.replace(PREAMBLES, "");
  text = text.replace(WRAPPING_QUOTES, "");
  // Markdown 符號會被朗讀出來，也會干擾 embedding
  text = text.replace(/[*#`_~]/g, "");
  text = text.replace(/\s{2,}/g, " ").trim();

  if (!text || NON_SPEECH.test(text)) return "";
  return text.slice(0, MAX_TRANSCRIPT_CHARS);
}

export function hasSttCredentials(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * 把音訊送去轉錄。回傳空字串代表「沒聽到人聲」，那是正常結果不是錯誤——
 * 呼叫端應該安靜地什麼都不做，而不是顯示錯誤訊息。
 *
 * ⚠️ `mimeType` 由呼叫端**看位元組認出來**再傳進來，不是照抄 Content-Type。
 */
export async function transcribe(
  audio: Uint8Array,
  mimeType = "audio/webm"
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              // 🔴 官方文件列的支援清單裡沒有 webm，但**實測是收的**。
              // 2026-08-20 對 gemini-3.5-flash 實打，逐字稿都正確：
              //   webm/opus（含 Chrome 那種標頭沒有總長度的）… 200
              //   ogg/opus ……………………………………………………………… 200
              //   mp4/aac（Safari 的 MediaRecorder 輸出）………… 200
              //   wav …………………………………………………………………………… 200
              // 之前照文件推論「不收 webm」，換來一條跨 AudioContext／
              // AudioWorklet／自動播放政策的自編 WAV 管線，以及五輪的
              // 「按住說話沒反應」。要改這一行之前先實測，不要再照文件推論。
              mimeType,
              data: Buffer.from(audio).toString("base64"),
            },
          },
          { text: PROMPT },
        ],
      },
    ],
    config: {
      temperature: TEMPERATURE,
      maxOutputTokens: 1024,
      // 見檔頭：這是延遲從 3.4 秒降到 1.0 秒的那一行
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  return sanitizeTranscript(response.text ?? "");
}

export { MODEL as STT_MODEL, MAX_TRANSCRIPT_CHARS };
