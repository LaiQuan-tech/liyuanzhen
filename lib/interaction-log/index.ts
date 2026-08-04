import { hasSupabase } from "../supabase";

export interface InteractionRecord {
  sessionId: string;
  questionText: string;
  answerSummary: string;
  topSimilarity: number;
  inScope: boolean;
  blocked: boolean;
}

/**
 * Stage 1 只寫 console（Vercel logs 看得到），Stage 2 自動改寫 Supabase。
 * 與檢索同樣採 provider 邊界，切換不用改呼叫端。
 */
export async function logInteraction(record: InteractionRecord): Promise<void> {
  if (hasSupabase()) {
    const { logToSupabase } = await import("./supabase");
    await logToSupabase(record);
    return;
  }
  console.log("[interaction]", JSON.stringify(record));
}
