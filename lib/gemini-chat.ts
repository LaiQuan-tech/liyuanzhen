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
 */
const MAX_OUTPUT_TOKENS = 2048;

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

  const stream = await ai.models.generateContentStream({
    model: CHAT_MODEL,
    contents,
    config: {
      systemInstruction,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
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

  let fullText = "";
  // 只拿來診斷空白答案（見迴圈後面）。兩個都記「看到的最後一個值」而不只看最後一個 chunk：
  // finishReason 通常只在最後一個 chunk，但 promptFeedback 依 SDK 說明只出現在第一個 chunk。
  let finishReason: string | undefined;
  let blockReason: string | undefined;
  for await (const chunk of stream) {
    const delta = chunk.text;
    if (delta) {
      fullText += delta;
      onTextDelta(delta);
    }
    finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
    blockReason = chunk.promptFeedback?.blockReason ?? blockReason;
  }

  // 🔴 模型回了零個字。正式站實測：「妳是同性戀嗎」回 HTTP 200、內容是空字串，訪客看到一個
  // 空白泡泡；後台近 30 天有 2 筆 answer_summary 是空字串，看起來跟正常回答一樣。
  // 推測是安全過濾或 finishReason 異常——把原因印出來，下次發生才分得出是哪一種。
  // 替代回覆與 failed 標記在 app/api/chat/route.ts；這裡的簽名與回傳值刻意不變。
  // 🔴 只記問題的字數，不記內容：log 會留在 Vercel。原本印前 20 字，但短問題會整句進 log
  // （「妳是同性戀嗎」就是）。要看是哪一題，用時間去後台 interactions 對。
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
