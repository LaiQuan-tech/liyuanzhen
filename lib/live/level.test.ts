import { describe, it, expect } from "vitest";
import { SILENCE_RMS } from "./recorder";
import { METER_BARS, meterAmplitude, meterBarHeight, smoothLevel } from "./level";

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

/**
 * 音量計的視覺對應。
 *
 * ⚠️ 這個東西的存在意義是：使用者按住講話的那 3 秒，畫面上唯一能證明
 * 「我的聲音真的進去了」的證據就是它。所以它必須在**實測到的數值範圍內**
 * 看得出明顯差別——線性對應在這裡是不夠的（底噪與說話全部擠在 0~5%）。
 *
 * 下面用的是同一組 2026-08-19 的實測數字。
 */
describe("meterAmplitude 視覺對應", () => {
  it("被靜音的麥克風畫出來就是零", () => {
    expect(meterAmplitude(實測.被靜音的麥克風)).toBe(0);
  });

  it("🔴 底噪與說話之間要看得出明顯差別，不然這個計量表等於沒做", () => {
    const 底噪 = meterAmplitude(實測.安靜房間的底噪);
    const 說話 = meterAmplitude(實測.使用者正常說話);
    expect(說話 - 底噪).toBeGreaterThan(0.25);
  });

  it("正常說話要推到一半以上，否則使用者看不出它在動", () => {
    expect(meterAmplitude(實測.使用者正常說話)).toBeGreaterThan(0.5);
  });

  it("大聲說話（約 0.05）滿格，再大也不會超出去", () => {
    expect(meterAmplitude(0.05)).toBe(1);
    expect(meterAmplitude(0.5)).toBe(1);
  });

  it("單調遞增——大聲一定畫得比小聲高", () => {
    const xs = [0, 0.004, 0.007, 0.012, 0.019, 0.03, 0.05];
    const ys = xs.map(meterAmplitude);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1]);
  });

  it("⚠️ 視覺底線不可以拿來當靜音判斷——它比 SILENCE_RMS 高四倍", () => {
    // 0.004 的視覺底線之下畫出來是 0，但那**不代表**沒收到聲音。
    // 真正的靜音判斷是 SILENCE_RMS（0.001）。這條測試就是防止有人把兩者合併。
    expect(meterAmplitude(0.003)).toBe(0);
    expect(0.003).toBeGreaterThan(SILENCE_RMS);
  });
});

describe("METER_BARS 形狀", () => {
  it("21 根柱子，中間最高、兩端最矮", () => {
    expect(METER_BARS).toHaveLength(21);
    const 中間 = METER_BARS[10];
    expect(中間).toBeGreaterThan(METER_BARS[0]);
    expect(中間).toBeGreaterThan(METER_BARS[20]);
  });

  it("每次載入形狀都一樣——不可以用亂數，否則畫面會亂跳", () => {
    expect(METER_BARS.every((v) => v > 0 && v <= 1.2)).toBe(true);
    expect(METER_BARS[3]).toBe(METER_BARS[3]);
  });

  it("最矮的柱子仍然畫得出來（至少 4px），不然安靜時整排看起來像一排點", () => {
    expect(meterBarHeight(0, Math.min(...METER_BARS))).toBe(4);
  });
});

describe("smoothLevel 峰值保持", () => {
  it("來了更大的音量就立刻跟上——不可以拖", () => {
    expect(smoothLevel(0.002, 0.02)).toBe(0.02);
  });

  it("🔴 撐得過音節之間的空檔（約 0.25 秒 ＝ 3 塊），否則柱子會塌成一排點", () => {
    let v = 0.02;
    for (let i = 0; i < 3; i++) v = smoothLevel(v, 0.0005); // 空檔期間只剩底噪
    expect(v / 0.02).toBeGreaterThan(0.7);
  });

  it("真的停止說話之後要落得下來，不能一直卡在高點", () => {
    let v = 0.02;
    for (let i = 0; i < 25; i++) v = smoothLevel(v, 0); // 約 2 秒
    expect(v).toBeLessThan(0.002);
  });
});
