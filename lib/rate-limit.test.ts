import { describe, it, expect, beforeEach } from "vitest";
import {
  rateLimit,
  clientIp,
  __resetRateLimit,
  LIMIT_PER_MINUTE,
  LIMIT_GLOBAL_PER_DAY,
  createRateLimiter,
  sttRateLimit,
  ttsRateLimit,
  avatarTokenRateLimit,
} from "./rate-limit";

describe("clientIp", () => {
  it("取 x-forwarded-for 的第一段（Vercel 的真實來源 IP）", () => {
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1, 10.0.0.2" });
    expect(clientIp(headers)).toBe("1.2.3.4");
  });

  it("退回 x-real-ip", () => {
    expect(clientIp(new Headers({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
  });

  it("都沒有時回 unknown，不能丟錯", () => {
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("rateLimit", () => {
  beforeEach(() => __resetRateLimit());

  it("額度內一律放行", () => {
    const now = 1_000_000;
    for (let i = 0; i < LIMIT_PER_MINUTE; i++) {
      expect(rateLimit("1.1.1.1", now).ok).toBe(true);
    }
  });

  it("超過每分鐘上限就擋，並給 retryAfter", () => {
    const now = 1_000_000;
    for (let i = 0; i < LIMIT_PER_MINUTE; i++) rateLimit("1.1.1.1", now);

    const verdict = rateLimit("1.1.1.1", now);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("per-minute");
    expect(verdict.retryAfter).toBeGreaterThan(0);
  });

  it("過了一分鐘視窗要恢復", () => {
    const now = 1_000_000;
    for (let i = 0; i < LIMIT_PER_MINUTE; i++) rateLimit("1.1.1.1", now);
    expect(rateLimit("1.1.1.1", now).ok).toBe(false);
    expect(rateLimit("1.1.1.1", now + 61_000).ok).toBe(true);
  });

  it("不同 IP 各自計算，不能互相拖累", () => {
    const now = 1_000_000;
    for (let i = 0; i < LIMIT_PER_MINUTE; i++) rateLimit("1.1.1.1", now);
    expect(rateLimit("1.1.1.1", now).ok).toBe(false);
    expect(rateLimit("2.2.2.2", now).ok).toBe(true);
  });
});

describe("createRateLimiter 的隔離性", () => {
  beforeEach(() => __resetRateLimit());

  it("⚠️ 不同端點的桶子互不干擾——這正是這次重構要修的問題", () => {
    // 一輪語音互動要打 stt → chat → tts 三支。共用桶子的話每問一句扣 3 格，
    // 20 格的額度實際上只剩每分鐘 6 個問題，而且是全場合計。
    const now = Date.now();
    for (let i = 0; i < LIMIT_PER_MINUTE; i++) {
      expect(sttRateLimit("1.1.1.1", now).ok).toBe(true);
    }
    // stt 這一支滿了
    expect(sttRateLimit("1.1.1.1", now).ok).toBe(false);
    // 但 chat 與 tts 一格都沒被吃掉
    expect(rateLimit("1.1.1.1", now).ok).toBe(true);
    expect(ttsRateLimit("1.1.1.1", now).ok).toBe(true);
  });

  it("同一支端點的不同 IP 也互不干擾", () => {
    const now = Date.now();
    for (let i = 0; i < LIMIT_PER_MINUTE; i++) sttRateLimit("1.1.1.1", now);
    expect(sttRateLimit("1.1.1.1", now).ok).toBe(false);
    expect(sttRateLimit("2.2.2.2", now).ok).toBe(true);
  });

  it("可以自訂額度：avatar-token 刻意比其他三支緊", () => {
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      expect(avatarTokenRateLimit("1.1.1.1", now).ok, `第 ${i + 1} 次`).toBe(true);
    }
    const verdict = avatarTokenRateLimit("1.1.1.1", now);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("per-minute");
  });

  it("全站每日總量是共用的——那是花費天花板，本來就該跨端點算", () => {
    const tiny = createRateLimiter({ name: "test-a", perMinute: 10_000, perDay: 10_000 });
    const other = createRateLimiter({ name: "test-b", perMinute: 10_000, perDay: 10_000 });
    const now = Date.now();

    // 用兩個 limiter 交替把全站額度打完
    for (let i = 0; i < LIMIT_GLOBAL_PER_DAY; i++) {
      (i % 2 === 0 ? tiny : other)(`ip-${i}`, now);
    }
    // 兩邊都該被全站上限擋下，而不是各自還有額度
    expect(tiny("fresh-ip", now).reason).toBe("global");
    expect(other("fresh-ip", now).reason).toBe("global");
  });

  it("被擋下的請求不計入全站總量——否則被擋的人會拖累其他人", () => {
    const limiter = createRateLimiter({ name: "test-c", perMinute: 2, perDay: 100 });
    const now = Date.now();
    limiter("1.1.1.1", now);
    limiter("1.1.1.1", now);
    // 這一次被每分鐘上限擋下
    expect(limiter("1.1.1.1", now).ok).toBe(false);

    // 全站額度應該只被吃掉 2 格，另一支端點還能正常用
    const another = createRateLimiter({ name: "test-d", perMinute: 5, perDay: 100 });
    expect(another("1.1.1.1", now).ok).toBe(true);
  });

  it("reset() 只清自己，不動別人", () => {
    const a = createRateLimiter({ name: "test-e", perMinute: 1, perDay: 100 });
    const b = createRateLimiter({ name: "test-f", perMinute: 1, perDay: 100 });
    const now = Date.now();
    a("1.1.1.1", now);
    b("1.1.1.1", now);
    expect(a("1.1.1.1", now).ok).toBe(false);
    expect(b("1.1.1.1", now).ok).toBe(false);

    a.reset();
    expect(a("1.1.1.1", now).ok).toBe(true);
    expect(b("1.1.1.1", now).ok).toBe(false);
  });
});

/**
 * 🔴 不花錢的端點不可以消耗全站的 AI 預算。
 *
 * LIMIT_GLOBAL_PER_DAY 是拿來擋 Gemini／ElevenLabs 費用的天花板。
 * 活動報名一支付費 API 都沒呼叫，如果它也計入那個總量，
 * 灌滿報名就能讓整站的語音與問答停擺一天——把成本上限變成阻斷服務的按鈕。
 */
describe("countsTowardGlobal", () => {
  it("不計入的端點，用光了也不會擋到會計入的端點", () => {
    __resetRateLimit();
    const free = createRateLimiter({
      name: "test-free",
      perMinute: 10_000,
      perDay: 10_000,
      countsTowardGlobal: false,
    });
    const paid = createRateLimiter({ name: "test-paid" });

    const now = Date.now();
    for (let i = 0; i < LIMIT_GLOBAL_PER_DAY + 50; i++) {
      // 每次換 key，才不會先撞到自己的每 IP 額度
      expect(free(`ip-${i}`, now).ok).toBe(true);
    }
    // 全站總量完全沒有被動到，付費端點照樣進得來
    expect(paid("someone", now).ok).toBe(true);
  });

  it("預設仍然計入——不要因為多了一個選項就把原本的保護關掉", () => {
    __resetRateLimit();
    const paid = createRateLimiter({ name: "test-default", perMinute: 10_000, perDay: 10_000 });
    const now = Date.now();
    for (let i = 0; i < LIMIT_GLOBAL_PER_DAY; i++) paid(`ip-${i}`, now);
    const verdict = paid("next-one", now);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("global");
  });
});
