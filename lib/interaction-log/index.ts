import { hasSupabase } from "../supabase";

/** 提問是從哪一個介面來的。null 代表 0005 之前的舊資料，補不回來。 */
export type InteractionChannel = "chat" | "live";

export interface InteractionRecord {
  sessionId: string;
  questionText: string;
  answerSummary: string;
  topSimilarity: number;
  inScope: boolean;
  blocked: boolean;
  /**
   * 系統出錯（檢索丟例外、或生成失敗）。
   *
   * 🔴 沒有這一欄的話，「抱歉，我這邊出了點狀況」會被存成一個正常的回答，
   * 而後台是拿這些紀錄來判斷數位人答得好不好的——會把 API 掛掉誤讀成語料有問題。
   */
  failed: boolean;
  channel: InteractionChannel | null;
}

/**
 * Stage 1 只寫 console（Vercel logs 看得到），Stage 2 自動改寫 Supabase。
 * 與檢索同樣採 provider 邊界，切換不用改呼叫端。
 *
 * ⚠️ 沒設 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 時只進 console log，
 * 呼叫端完全看不出差別——本機看不到後台有資料，先確認這兩個環境變數。
 */
export async function logInteraction(record: InteractionRecord): Promise<void> {
  if (hasSupabase()) {
    const { logToSupabase } = await import("./supabase");
    await logToSupabase(record);
    return;
  }
  console.log("[interaction]", JSON.stringify(record));
}
