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
      // 🔴 這裡本來完全沒設，等於用 Gemini 預設的 temperature 1.0，每次重抽。
      // 症狀是使用者聽得出來的：「為什麼每次回答，聲音會稍許不同？」
      // 變的其實不是嗓子，是文字——字不一樣就長度不一樣、標點位置不一樣，
      // 朗讀的節奏與停頓跟著全變。
      //
      // 2026-09-08 用 eval:voice 同一組 12 題連跑兩輪量到的文字重疊度：
      //   平均 67%（三分之一的字不同）
      //   「你支持哪一個政黨？」36.6%（58 字 vs 13 字）
      //   「你是真人嗎？」      46.7%（50 字 vs 70 字）
      //
      // ⚠️ 沒有動 ElevenLabs 那一層（`lib/voice/index.ts` 送出的 body 至今沒有
      // seed 也沒有 voice_settings）。那一層要壓變異就得拉高 stability，
      // 代價是語氣變平，會抵銷語音調校。這裡先修沒有副作用的那一半。
      temperature: 0.3,
      // ⚠️ 不要加 thinkingConfig: { thinkingBudget: 0 }。
      // gemini-flash-latest 會回 400 INVALID_ARGUMENT（已實測隔離確認）。
      // 那個技巧適用於 gemini-3.5-flash 之類的特定版本，不適用於這個別名。
    },
  });

  let fullText = "";
  for await (const chunk of stream) {
    const delta = chunk.text;
    if (delta) {
      fullText += delta;
      onTextDelta(delta);
    }
  }
  return fullText;
}

export { CHAT_MODEL };
