/**
 * 每次呼叫 /api/chat 都在花錢（Gemini 額度）。公開網址上一定要擋。
 *
 * ⚠️ 誠實的限制：這是行程內記憶體，Vercel 多實例之間不共享，
 * 也會在冷啟動時歸零。它擋得住手滑連點與隨手寫的腳本，擋不住認真的攻擊。
 * **真正的最後防線是 Google Cloud 上的硬預算上限**，上線前務必設定。
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const perMinute = new Map<string, Bucket>();
const perDay = new Map<string, Bucket>();
let globalDay: Bucket = { count: 0, resetAt: 0 };

// ⚠️ 提案現場的整個會議室共用同一個對外 NAT IP，
// 所以「每 IP」的額度實際上是「全場合計」。訂太緊會在示範途中當眾被自己擋下來。
// 20/分鐘約等於全場每 3 秒一則，足夠一場示範，也仍然擋得住手滑連點與隨手寫的腳本。
const LIMIT_PER_MINUTE = 20;
const LIMIT_PER_DAY = 200;
const LIMIT_GLOBAL_PER_DAY = 1500;

const MINUTE = 60_000;
const DAY = 24 * 60 * 60_000;

/** Vercel 會把真實來源 IP 放在 x-forwarded-for 的第一段 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return headers.get("x-real-ip") ?? "unknown";
}

function hit(store: Map<string, Bucket>, key: string, limit: number, span: number, now: number) {
  const existing = store.get(key);
  if (!existing || now >= existing.resetAt) {
    store.set(key, { count: 1, resetAt: now + span });
    return { ok: true, retryAfter: 0 };
  }
  if (existing.count >= limit) {
    return { ok: false, retryAfter: Math.ceil((existing.resetAt - now) / 1000) };
  }
  existing.count++;
  return { ok: true, retryAfter: 0 };
}

/** 順手清掉過期的 key，避免長壽實例的 Map 無限長大 */
function sweep(store: Map<string, Bucket>, now: number) {
  if (store.size < 500) return;
  const stale: string[] = [];
  store.forEach((bucket, key) => {
    if (now >= bucket.resetAt) stale.push(key);
  });
  stale.forEach((key) => store.delete(key));
}

export interface RateLimitVerdict {
  ok: boolean;
  reason?: "per-minute" | "per-day" | "global";
  retryAfter: number;
}

export function rateLimit(ip: string, now: number = Date.now()): RateLimitVerdict {
  sweep(perMinute, now);
  sweep(perDay, now);

  if (now >= globalDay.resetAt) {
    globalDay = { count: 0, resetAt: now + DAY };
  }
  if (globalDay.count >= LIMIT_GLOBAL_PER_DAY) {
    return {
      ok: false,
      reason: "global",
      retryAfter: Math.ceil((globalDay.resetAt - now) / 1000),
    };
  }

  const minute = hit(perMinute, ip, LIMIT_PER_MINUTE, MINUTE, now);
  if (!minute.ok) return { ok: false, reason: "per-minute", retryAfter: minute.retryAfter };

  const day = hit(perDay, ip, LIMIT_PER_DAY, DAY, now);
  if (!day.ok) return { ok: false, reason: "per-day", retryAfter: day.retryAfter };

  globalDay.count++;
  return { ok: true, retryAfter: 0 };
}

/** 測試用 */
export function __resetRateLimit() {
  perMinute.clear();
  perDay.clear();
  globalDay = { count: 0, resetAt: 0 };
}

export { LIMIT_PER_MINUTE, LIMIT_PER_DAY, LIMIT_GLOBAL_PER_DAY };
