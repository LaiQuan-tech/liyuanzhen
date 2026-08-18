/**
 * 每次呼叫 AI 端點都在花錢（Gemini／ElevenLabs／LiveAvatar 額度）。
 * 公開網址上一定要擋。
 *
 * ⚠️ 誠實的限制：這是行程內記憶體，Vercel 多實例之間不共享，
 * 也會在冷啟動時歸零。它擋得住手滑連點與隨手寫的腳本，擋不住認真的攻擊。
 * **真正的最後防線是各家後台的硬預算上限**，上線前務必設定。
 *
 * ⚠️ 為什麼是 factory 而不是單一個全域計數器：
 *
 * 一輪語音互動（/live 的按住說話）要打三支端點——
 *   /api/stt（轉逐字稿）→ /api/chat（RAG＋生成）→ /api/tts（合成她的聲音）
 * 三支共用同一個 IP bucket 的話，每問一句就扣 3 格，20 格的額度實際上
 * **只剩每分鐘 6 個問題**，而且是全場合計（見下方 NAT 的說明）。
 * 提案示範到一半當眾被自己的限流擋下來，是最不需要的失分。
 *
 * 所以每支端點自己一個 bucket，但**全站每日總量共用**——
 * 那是花費天花板，本來就該跨端點計算。
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * 60_000;

// ⚠️ 提案現場的整個會議室共用同一個對外 NAT IP，
// 所以「每 IP」的額度實際上是「全場合計」。訂太緊會在示範途中當眾被自己擋下來。
// 20/分鐘約等於全場每 3 秒一則，足夠一場示範，也仍然擋得住手滑連點與隨手寫的腳本。
const LIMIT_PER_MINUTE = 20;
const LIMIT_PER_DAY = 200;

/**
 * 全站每日總量，跨所有端點共用。
 *
 * ⚠️ 這個數字的單位是「請求」不是「問題」。語音一輪要打 3 支端點，
 * 所以 4000 約等於 1300 輪語音對話——對一個提案展示站綽綽有餘，
 * 但仍然是一道真正的天花板。改的時候記得換算。
 */
const LIMIT_GLOBAL_PER_DAY = Number(process.env.RATE_LIMIT_GLOBAL_PER_DAY ?? 4000);

/** 全站共用的每日總量。刻意放在模組層級，所有 limiter 都撞同一個。 */
let globalDay: Bucket = { count: 0, resetAt: 0 };

/** 建出來的 limiter 都登記在這，`__resetRateLimit()` 才有辦法一次清乾淨。 */
const registry: { reset(): void }[] = [];

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

export interface RateLimiter {
  (key: string, now?: number): RateLimitVerdict;
  /** 只清這一個 limiter 的桶子，不動全站總量 */
  reset(): void;
}

export interface RateLimiterOptions {
  /** 只用來除錯與辨識，不影響行為 */
  name: string;
  perMinute?: number;
  perDay?: number;
}

/**
 * 開一個獨立的額度桶。
 *
 * ⚠️ 每支端點各叫一次，**不要共用**——共用就退回這次要修掉的那個問題。
 * 但全站每日總量是共用的，那是花費上限不是防濫用。
 */
export function createRateLimiter({
  name,
  perMinute = LIMIT_PER_MINUTE,
  perDay = LIMIT_PER_DAY,
}: RateLimiterOptions): RateLimiter {
  const minuteStore = new Map<string, Bucket>();
  const dayStore = new Map<string, Bucket>();

  const limiter = ((key: string, now: number = Date.now()): RateLimitVerdict => {
    sweep(minuteStore, now);
    sweep(dayStore, now);

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

    const minute = hit(minuteStore, key, perMinute, MINUTE, now);
    if (!minute.ok) return { ok: false, reason: "per-minute", retryAfter: minute.retryAfter };

    const day = hit(dayStore, key, perDay, DAY, now);
    if (!day.ok) return { ok: false, reason: "per-day", retryAfter: day.retryAfter };

    globalDay.count++;
    return { ok: true, retryAfter: 0 };
  }) as RateLimiter;

  limiter.reset = () => {
    minuteStore.clear();
    dayStore.clear();
  };
  // name 目前只在除錯時看，但登記進 registry 讓 __resetRateLimit 找得到
  Object.defineProperty(limiter, "name", { value: `rateLimit:${name}` });
  registry.push(limiter);
  return limiter;
}

/**
 * /api/chat 的額度。
 *
 * ⚠️ 這個具名匯出必須保留、行為必須不變——`lib/rate-limit.test.ts` 直接測它，
 * 而那些測試是限流語意的規格書，不該為了重構而改。
 */
export const rateLimit: RateLimiter = createRateLimiter({ name: "chat" });

/** /api/tts。跟 chat 同級，因為語音互動一定成對出現。 */
export const ttsRateLimit: RateLimiter = createRateLimiter({ name: "tts" });

/** /api/stt。同上。 */
export const sttRateLimit: RateLimiter = createRateLimiter({ name: "stt" });

/**
 * /api/avatar-token。額度刻意比其他三支低——
 * 鑄一張 token 就是開一個計費 session，正常使用一場對話只需要一張。
 * 真正的防線是帳本（lib/avatar-ledger）的並發與預算判定，這裡只是減速丘。
 */
export const avatarTokenRateLimit: RateLimiter = createRateLimiter({
  name: "avatar-token",
  perMinute: 12,
  perDay: 100,
});

/** 測試用：清掉所有 limiter 的桶子與全站總量 */
export function __resetRateLimit() {
  registry.forEach((limiter) => limiter.reset());
  globalDay = { count: 0, resetAt: 0 };
}

export { LIMIT_PER_MINUTE, LIMIT_PER_DAY, LIMIT_GLOBAL_PER_DAY };
