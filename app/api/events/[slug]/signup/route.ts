import type { NextRequest } from "next/server";
import { clientIp, signupRateLimit } from "@/lib/rate-limit";
import {
  getPublicEvent,
  createRegistration,
  validateRegistration,
  acceptsRegistration,
  MAX_PARTY_SIZE,
} from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * 活動報名。
 *
 * 🔴 這是全站第一支會蒐集**可直接識別個人**資料的端點（姓名、信箱、電話）。
 * 幾條不可以放寬的規矩：
 *
 * 1. 寫入一律走 service_role，瀏覽器拿不到任何金鑰。
 *    直接讓前端用 anon key insert，等於把一把有寫入權的鑰匙放進原始碼裡；
 *    哪天 select policy 寫鬆一格，整份名單就攤開了。
 * 2. `consent` 必須是 true 才收。那不是介面上的禮貌，是蒐集個資的前提。
 * 3. 回應**不要**回傳寫進去的內容。回了就等於做出一支「拿 id 換個資」的端點。
 * 4. 只有 published 的場次收報名。closed 的收了，等於讓人白跑一趟。
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

export async function POST(request: NextRequest, { params }: { params: { slug: string } }) {
  if (!originAllowed(request)) {
    return json({ error: "請從本網站發起報名。" }, 403);
  }

  const verdict = signupRateLimit(clientIp(request.headers));
  if (!verdict.ok) {
    return json({ error: "送出太頻繁了，請稍等一下。", reason: verdict.reason }, 429);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "格式錯誤。" }, 400);
  }

  // ⚠️ party_size 從表單來的是字串。Number("") 是 0 不是 NaN，
  // 所以空字串會變成 0 而被驗證擋下——那正是我們要的，不要在這裡補成 1。
  const input = {
    name: String(body.name ?? ""),
    email: String(body.email ?? ""),
    phone: String(body.phone ?? ""),
    party_size: Number(body.party_size ?? 1),
    note: String(body.note ?? ""),
    consent: body.consent === true,
  };

  const check = validateRegistration(input);
  if (!check.ok) {
    return json({ error: check.errors[0], errors: check.errors }, 400);
  }

  let event;
  try {
    event = await getPublicEvent(params.slug);
  } catch (error) {
    console.error("[signup] 讀取活動失敗：", error);
    return json({ error: "報名暫時無法送出，請稍後再試。" }, 502);
  }

  // 找不到、或還是草稿——對外一律當成不存在，不要洩漏「有這一場但還沒公開」
  if (!event) return json({ error: "找不到這個場次。" }, 404);

  if (!acceptsRegistration(event.status)) {
    return json({ error: "這一場已經截止報名了。", reason: "closed" }, 409);
  }

  try {
    await createRegistration(event.id, check.value!);
  } catch (error) {
    console.error("[signup] 寫入失敗：", error);
    return json({ error: "報名暫時無法送出，請稍後再試。" }, 502);
  }

  // 只回成功，不回內容。見上面第 3 條。
  return json({ ok: true, maxPartySize: MAX_PARTY_SIZE });
}
