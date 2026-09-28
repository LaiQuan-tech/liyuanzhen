import { GoogleGenAI } from "@google/genai";
import { buildSystemPrompt } from "./persona-prompt";
import type { KnowledgeChunk } from "./retrieval/types";
import type { HistoryTurn } from "./query-expansion";

// 用 -latest 別名而非釘死版本：gemini-2.5-flash 曾對新帳號回 404。
// 別名會自動指向當前 flash，避免模型退役讓網站在提案當天掛掉。
const CHAT_MODEL = "gemini-flash-latest";

/**
 * ⚠️ 這個值不是用來控制回答長度的，長度由 persona prompt 的「3 到 5 句」負責。
 *
 * gemini-flash-latest 是 thinking 模型，**內部思考的 token 會算進 maxOutputTokens**。
 * 設 400 的話思考就把額度吃光，可見回答會在半句話中被硬生生切斷
 * （實測症狀：回答只剩十幾個字且從句中開始）。
 * 又因為這個模型會拒絕 thinkingConfig，無法關掉思考，只能把上限放寬。
 *
 * 🔴 2026-09-28：2048 也不夠了。規則變多之後，本機 141 題有 3 題 finishReason=MAX_TOKENS，
 * 可見文字只有 93–152 字（其餘全被思考吃掉），其中一題的可見文字開頭是模型推理的殘句（「", asking fo」）。
 * 這個上限不影響沒被截斷的回答（模型看不到它），只決定思考很長的那幾題是截斷還是答完，所以放寬到 8192。
 */
const MAX_OUTPUT_TOKENS = 8192;

/**
 * 🔴 2026-09-28 第十五輪（獨立審查）：生成逾時。
 *
 * app/api/chat/route.ts 的 maxDuration 是 30 秒，超過就被平台直接中止：訪客看到的是連線錯誤，
 * 後台也不會有紀錄（紀錄是在生成結束之後才寫）。MAX_OUTPUT_TOKENS 剛從 2048 放寬到 8192，
 * 思考很長的題目就有機會撞上這條線。所以生成自己先停：時間到就用 config.abortSignal 中止串流、丟例外，
 * 交給 route 的生成失敗分支（FALLBACK_REPLY、記 failed；危機延續中送同一句危機回覆）。
 * 24 秒＝30 秒扣掉生成之前的檢索（embedding＋向量查詢）與生成之後寫紀錄的時間。
 * ⚠️ abortSignal 只中止這一端（SDK 註解：不會取消服務端的請求，用量照樣計費）。
 */
export const GENERATION_TIMEOUT_MS = 24_000;

/** 只保留最近幾輪，控制成本也避免舊脈絡污染 */
const MAX_HISTORY_TURNS = 6;
const MAX_TURN_CHARS = 400;

function createClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenAI({ apiKey });
}

export async function streamChatResponse(
  question: string,
  chunks: KnowledgeChunk[],
  history: HistoryTurn[],
  onTextDelta: (text: string) => void,
  options: { lowConfidence?: boolean } = {}
): Promise<string> {
  const ai = createClient();
  const systemInstruction = buildSystemPrompt(chunks, options);

  // 使用者輸入永遠放 contents，絕不併進 system prompt——防 prompt injection 的結構性作法
  const contents = [
    ...history.slice(-MAX_HISTORY_TURNS).map((turn) => ({
      role: turn.role,
      parts: [{ text: turn.text.slice(0, MAX_TURN_CHARS) }],
    })),
    { role: "user" as const, parts: [{ text: question }] },
  ];

  // 生成逾時（見 GENERATION_TIMEOUT_MS）。計時從送出請求開始，涵蓋等第一個字（思考）與整段串流
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), GENERATION_TIMEOUT_MS);

  let fullText = "";
  // 只拿來診斷空白答案（見迴圈後面）。兩個都記「看到的最後一個值」而不只看最後一個 chunk：
  // finishReason 通常只在最後一個 chunk，但 promptFeedback 依 SDK 說明只出現在第一個 chunk。
  let finishReason: string | undefined;
  let blockReason: string | undefined;
  try {
    const stream = await ai.models.generateContentStream({
      model: CHAT_MODEL,
      contents,
      config: {
        systemInstruction,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        abortSignal: abort.signal,
        // 🔴 這裡刻意不設 temperature。設了沒有用——這是量出來的，不要再試一次。
        //
        // 起因是使用者問「為什麼每次回答，聲音會稍許不同？」。變的不是嗓子是文字：
        // 同一組 12 題連跑兩輪，文字重疊度平均只有 67%（「你支持哪一個政黨？」36.6%，
        // 58 字 vs 13 字）。字不一樣就長度不一樣、標點位置不一樣，朗讀的節奏跟著全變。
        //
        // 我以為原因是沒設 temperature（走預設 1.0），加了 0.3 部署上線再量兩輪：
        //   文字重疊度 67.0% → 64.4%   沒有改善，還在雜訊裡
        //
        // 直接打 SDK 驗才知道為什麼：**temperature=0 連續三次仍然三種答案**
        // （同一組 systemInstruction + contents，gemini-flash-latest）。
        // 也就是說這個模型的服務端本身就不決定性——批次組成與浮點加總次序會變，
        // logits 就跟著變，不是把採樣關掉能解決的。
        //
        // ⚠️ 所以要讓同一個問題聽起來一樣，唯一的路是**快取答案**（連音檔一起快取
        // 更徹底），不是調採樣參數。ElevenLabs 那一層（lib/voice/index.ts 至今沒送
        // seed 也沒送 voice_settings）只有在文字已經固定的前提下才值得處理。
        // ⚠️ 不要加 thinkingConfig: { thinkingBudget: 0 }。
        // gemini-flash-latest 會回 400 INVALID_ARGUMENT（已實測隔離確認）。
        // 那個技巧適用於 gemini-3.5-flash 之類的特定版本，不適用於這個別名。
      },
    });

    for await (const chunk of stream) {
      const delta = chunk.text;
      if (delta) {
        fullText += delta;
        onTextDelta(delta);
      }
      finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
      blockReason = chunk.promptFeedback?.blockReason ?? blockReason;
    }
  } catch (err) {
    if (!abort.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
  }
  // 中止之後 SDK 通常會讓串流丟例外（上面的 catch）；萬一它安靜地結束了，拿到的也只是半截，一樣當逾時處理
  if (abort.signal.aborted) {
    // 🔴 只記字數與秒數，不記問題內容（理由同下面空白答案那一段：log 會留在 Vercel）
    console.warn("[chat] 生成逾時，已中止", {
      seconds: GENERATION_TIMEOUT_MS / 1000,
      chars: Array.from(fullText).length,
      questionChars: Array.from(question).length,
    });
    throw new Error(`TIMEOUT：生成超過 ${GENERATION_TIMEOUT_MS / 1000} 秒，已中止`);
  }

  // 🔴 模型回了零個字。正式站實測：「妳是同性戀嗎」回 HTTP 200、內容是空字串，訪客看到一個
  // 空白泡泡；後台近 30 天有 2 筆 answer_summary 是空字串，看起來跟正常回答一樣。
  // 推測是安全過濾或 finishReason 異常——把原因印出來，下次發生才分得出是哪一種。
  // 替代回覆與 failed 標記在 app/api/chat/route.ts；這裡的簽名與回傳值刻意不變。
  // 🔴 只記問題的字數，不記內容：log 會留在 Vercel。原本印前 20 字，但短問題會整句進 log
  // （「妳是同性戀嗎」就是）。要看是哪一題，用時間去後台 interactions 對。
  // 🔴 2026-09-28：輸出被截斷。gemini-flash-latest 的思考會算進 maxOutputTokens（見上面 MAX_OUTPUT_TOKENS），
  // 規則變多之後，實測有一次訪客看到的是模型數字數的推理加半句話（「…Let's check clause lengths…它對我就」）。
  // 截斷的回答一定不完整，丟例外交給 route 的生成失敗分支（回「抱歉，我這邊出了點狀況」並記 failed，
  // 危機延續也在那裡處理）——比把半句話送給訪客好。推理字眼另由 lib/answer-guard.ts 的封鎖清單擋。
  if (finishReason === "MAX_TOKENS") {
    console.warn("[chat] 模型輸出被截斷（MAX_TOKENS）", {
      chars: Array.from(fullText).length,
      questionChars: Array.from(question).length,
    });
    throw new Error("MAX_TOKENS：模型輸出被截斷");
  }

  // 🔴 第十五輪（獨立審查）：上面只接 MAX_TOKENS。SAFETY、RECITATION、OTHER、PROHIBITED_CONTENT 這些原因半途停下、
  // 而且已經吐了字的時候，半截照常回傳，被當成正常回答送給訪客、存進紀錄（審查探針：7 種原因裡 6 種都是這樣）。
  // 有字、而且 finishReason 在但不是 STOP → 一樣丟例外，走 route 的生成失敗分支（FALLBACK_REPLY、記 failed）。
  // 空白答案照舊回空字串（下面那一段），由 route 換 UNGROUNDED_REPLY 並記 failed。finishReason 沒給的不動。
  if (fullText.trim() && finishReason && finishReason !== "STOP") {
    console.warn("[chat] 模型輸出異常結束", {
      finishReason,
      chars: Array.from(fullText).length,
      questionChars: Array.from(question).length,
    });
    throw new Error(`${finishReason}：模型輸出異常結束`);
  }

  if (!fullText.trim()) {
    console.warn("[chat] 模型回了空白答案", {
      finishReason: finishReason ?? null,
      blockReason: blockReason ?? null,
      questionChars: Array.from(question).length,
    });
  }
  return fullText;
}

export { CHAT_MODEL };
