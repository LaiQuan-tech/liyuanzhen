import type { NextRequest } from "next/server";
import { closeSession, settleStaleSessions } from "@/lib/avatar-ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * 「這個 session 結束了」。瀏覽器收線時用 `navigator.sendBeacon` 打這一支。
 *
 * 🔴 這支端點不存在的那段期間，帳本只記得到「開了幾個 session」，
 * 記不到「用了幾分鐘」——而後者才是帳單上的數字。實測正式站 88 筆裡
 * `billed_minutes` 有值的是 0 筆，`closeSession()` 寫好了卻沒有任何呼叫者。
 *
 * ⚠️ 時長由**伺服器**用 `started_at` 算，不接受瀏覽器報上來的秒數。
 * 這一支沒有身分驗證（sendBeacon 帶不了什麼），所以任何能猜到 session id 的人
 * 都能提早結算它。收下一個客戶端自報的時長，等於讓對方決定我們的帳。
 *
 * ⚠️ 提早結算的後果只是**低估**用量，不會多花錢，所以不做限流——
 * 限流反而會讓正常的收線訊號被丟掉，那才是真正的損失。
 */

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** 跟其他端點同一套第一道防線。腳本可偽造，所以只是減速丘。 */
function originAllowed(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!originAllowed(request)) return json({ error: "請從本網站發起請求。" }, 403);

  let sessionId: unknown;
  try {
    ({ sessionId } = (await request.json()) as { sessionId?: unknown });
  } catch {
    return json({ error: "格式錯誤。" }, 400);
  }
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 200) {
    return json({ error: "缺少 sessionId。" }, 400);
  }

  try {
    await closeSession(sessionId);
  } catch (error) {
    // ⚠️ 結算失敗不可以讓請求看起來成功，但也不用驚動使用者——
    // 收不到訊號的那條路（以上限估算）本來就是設計裡的退路。
    console.error("[avatar-session] 結算失敗：", error);
    return json({ error: "結算失敗。" }, 502);
  }

  // 順手把逾時的殭屍補結算。這一支不在使用者等待的路徑上，
  // 放在這裡比放在發 token 的熱路徑上便宜。
  try {
    await settleStaleSessions();
  } catch (error) {
    console.error("[avatar-session] 殭屍結算失敗：", error);
  }

  return json({ ok: true });
}

/** 只跑殭屍結算。給 cron 或手動觸發用。 */
export async function GET() {
  try {
    const settled = await settleStaleSessions();
    return json({ settled });
  } catch (error) {
    console.error("[avatar-session] 殭屍結算失敗：", error);
    return json({ error: "結算失敗。" }, 502);
  }
}
