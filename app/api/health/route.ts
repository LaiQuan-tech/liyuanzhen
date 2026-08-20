import { createAdminSupabase, hasSupabase } from "@/lib/supabase";

export const runtime = "nodejs";
/**
 * 🔴 不可以拿掉。少了這一行，Vercel 會把這支預先算好放到邊緣快取
 *（實測正式站 `x-vercel-cache: HIT`、`age: 141`），於是：
 *   1. 它回報的是**建置當下**資料庫的狀態，資料庫現在掛了它照樣回 200
 *   2. 拿它預熱 lambda 完全無效——請求連 lambda 都碰不到
 * 這兩件事下面的註解都寫了要避免，但少了這一行都沒有做到。
 */
export const dynamic = "force-dynamic";

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
