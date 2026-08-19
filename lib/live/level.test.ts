import { describe, it, expect } from "vitest";
import { SILENCE_RMS } from "./recorder";

/**
 * 把「什麼叫沒收到聲音」的門檻釘住。
 *
 * ⚠️ 這條測試存在的原因是一次真實的誤判：門檻曾經設成 0.01，
 * 結果使用者按住、講完、放開，畫面回他「沒有收到聲音，請確認麥克風有開」——
 * 但他明明講了，而且錄音器完整收到 3 秒 147456 個取樣。
 *
 * 下面的數字全部是 2026-08-19 在 Chrome ＋ 真實麥克風
 * （echoCancellation / noiseSuppression / autoGainControl 皆開）量到的。
 * 改門檻之前先看這些數字，不要憑感覺調。
 */
const 實測 = {
  被靜音的麥克風: 0,
  安靜房間的底噪: 0.00706,
  使用者正常說話: 0.0185,
};

describe("SILENCE_RMS 門檻", () => {
  it("⚠️ 只擋真正的數位靜音——被靜音的麥克風", () => {
    expect(實測.被靜音的麥克風).toBeLessThan(SILENCE_RMS);
  });

  it("🔴 安靜房間的底噪不可以被判成靜音（曾經被誤判）", () => {
    expect(實測.安靜房間的底噪).toBeGreaterThan(SILENCE_RMS);
  });

  it("🔴 正常說話更不可以被判成靜音（就是這個 bug）", () => {
    expect(實測.使用者正常說話).toBeGreaterThan(SILENCE_RMS);
  });

  it("門檻要離底噪夠遠——至少差三倍，否則環境一變就誤判", () => {
    expect(實測.安靜房間的底噪 / SILENCE_RMS).toBeGreaterThan(3);
  });
});
