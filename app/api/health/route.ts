import { createAdminSupabase, hasSupabase } from "@/lib/supabase";

export const runtime = "nodejs";

/**
 * 首頁掛載時會 ping 這支預熱 lambda，避免第一個問題卡在冷啟動。
 *
 * 有設定 Supabase 就順便真的探一次庫——只回 {ok:true} 的健康檢查是假的，
 * 資料庫掛了它照樣回 200，拿來接外部監控就形同虛設。
 * 探庫同時也把 DB 連線熱起來，第一個問題會更快。
 *
 * 沒設定 Supabase（Stage 1 本機向量檔模式）時回 200，
 * 因為那個模式下資料庫本來就不在服務路徑上，回 503 反而是誤報。
 */
export async function GET() {
  if (!hasSupabase()) {
    return Response.json({ status: "ok", store: "local" }, { status: 200 });
  }

  try {
    const supabase = createAdminSupabase();
    const { error } = await supabase.from("knowledge_chunks").select("id").limit(1);
    if (error) throw new Error(error.message);
    return Response.json({ status: "ok", store: "supabase" }, { status: 200 });
  } catch (err) {
    console.error("health check failed:", err);
    return Response.json({ status: "error" }, { status: 503 });
  }
}
