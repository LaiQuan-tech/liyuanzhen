import { createAdminSupabase } from "../supabase";
import type { InteractionRecord } from "./index";

/**
 * 注意：question_text 存的是訪客原始輸入。
 * 若日後要對外承諾「不蒐集個資」，需另外決定是否過濾——這是產品決策，不是技術缺陷。
 *
 * ⚠️ 這張表現在有後台在讀了（/admin/interactions）。
 * 這裡多存或少存一個欄位，那一頁就會跟著變準或變不準。
 */
export async function logToSupabase(record: InteractionRecord): Promise<void> {
  const supabase = createAdminSupabase();
  const { error } = await supabase.from("interactions").insert({
    session_id: record.sessionId,
    question_text: record.questionText.slice(0, 1000),
    answer_summary: record.answerSummary.slice(0, 500),
    top_similarity: record.topSimilarity,
    in_scope: record.inScope,
    blocked: record.blocked,
    failed: record.failed,
    channel: record.channel,
  });
  if (error) throw new Error(`互動記錄寫入失敗：${error.message}`);
}
