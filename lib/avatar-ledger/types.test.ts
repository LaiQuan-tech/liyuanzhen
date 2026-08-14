import { describe, it, expect } from "vitest";
import {
  decideAdmission,
  isStale,
  billableMinutes,
  type LedgerLimits,
} from "./types";

const limits: LedgerLimits = {
  maxConcurrent: 36,
  monthlyMinuteBudget: 30_000,
  maxSessionSeconds: 180,
  enabled: true,
};

describe("decideAdmission", () => {
  it("有餘裕就放行，並回報單次時長上限", () => {
    const r = decideAdmission({ activeSessions: 10, monthMinutesUsed: 100 }, limits);
    expect(r).toEqual({ admit: true, maxSessionSeconds: 180 });
  });

  it("killswitch 關掉時一律拒絕，優先於其他判斷", () => {
    const r = decideAdmission(
      { activeSessions: 0, monthMinutesUsed: 0 },
      { ...limits, enabled: false }
    );
    expect(r).toEqual({ admit: false, reason: "disabled", queueAhead: 0 });
  });

  it("預算用完 → budget_exhausted，而且不叫人排隊", () => {
    const r = decideAdmission(
      { activeSessions: 0, monthMinutesUsed: 30_000 },
      limits
    );
    expect(r).toEqual({ admit: false, reason: "budget_exhausted", queueAhead: 0 });
  });

  it("⚠️ 預算用完時就算並發是滿的，也要回 budget_exhausted 不是 at_capacity", () => {
    // 不然會叫人去排一個今天永遠排不到的隊
    const r = decideAdmission(
      { activeSessions: 999, monthMinutesUsed: 30_000 },
      limits
    );
    expect(r).toMatchObject({ admit: false, reason: "budget_exhausted" });
  });

  it("並發滿了 → at_capacity，並給出前面還有幾位", () => {
    const r = decideAdmission({ activeSessions: 36, monthMinutesUsed: 0 }, limits);
    expect(r).toEqual({ admit: false, reason: "at_capacity", queueAhead: 1 });
  });

  it("超載越多，排隊數字越大", () => {
    const r = decideAdmission({ activeSessions: 40, monthMinutesUsed: 0 }, limits);
    expect(r).toMatchObject({ reason: "at_capacity", queueAhead: 5 });
  });

  it("剛好在上限前一個仍然放行（邊界）", () => {
    const r = decideAdmission({ activeSessions: 35, monthMinutesUsed: 0 }, limits);
    expect(r).toMatchObject({ admit: true });
  });

  it("預算剛好差一分鐘仍然放行（邊界）", () => {
    const r = decideAdmission(
      { activeSessions: 0, monthMinutesUsed: 29_999 },
      limits
    );
    expect(r).toMatchObject({ admit: true });
  });
});

describe("isStale", () => {
  const now = 1_000_000_000_000;

  it("剛開始的 session 不是殭屍", () => {
    expect(isStale(now - 10_000, now, 180)).toBe(false);
  });

  it("還沒超過上限加緩衝就不算殭屍", () => {
    expect(isStale(now - 200_000, now, 180)).toBe(false); // 200s < 180+30
  });

  it("⚠️ 超過上限加緩衝就當它死了，不管有沒有收到關閉訊號", () => {
    // 訪客關分頁、切 app、鎖屏都不會送關閉訊號。
    // 不靠時間清掉的話，額度會被殭屍鎖死，最後整站沒人能用。
    expect(isStale(now - 300_000, now, 180)).toBe(true);
  });

  it("緩衝可調", () => {
    expect(isStale(now - 190_000, now, 180, 5)).toBe(true);
    expect(isStale(now - 190_000, now, 180, 60)).toBe(false);
  });
});

describe("billableMinutes", () => {
  const t0 = 1_000_000_000_000;

  it("⚠️ 無條件進位——講 10 秒也算 1 分鐘，要跟帳單同一套算法", () => {
    expect(billableMinutes(t0, t0 + 10_000, 180)).toBe(1);
  });

  it("61 秒算 2 分鐘", () => {
    expect(billableMinutes(t0, t0 + 61_000, 180)).toBe(2);
  });

  it("整分鐘不多算", () => {
    expect(billableMinutes(t0, t0 + 120_000, 180)).toBe(2);
  });

  it("⚠️ 殭屍 session 的推估結束時間不能算出天文數字", () => {
    // endedAt 是我們推估的，可能離 startedAt 很久
    expect(billableMinutes(t0, t0 + 86_400_000, 180)).toBe(3); // 封頂在 180 秒
  });

  it("時間倒退不會算出負數", () => {
    expect(billableMinutes(t0, t0 - 5_000, 180)).toBe(0);
  });

  it("零長度是 0 不是 1", () => {
    expect(billableMinutes(t0, t0, 180)).toBe(0);
  });
});
