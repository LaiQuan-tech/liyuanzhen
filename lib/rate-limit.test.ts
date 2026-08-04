import { describe, it, expect, beforeEach } from "vitest";
import {
  rateLimit,
  clientIp,
  __resetRateLimit,
  LIMIT_PER_MINUTE,
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
