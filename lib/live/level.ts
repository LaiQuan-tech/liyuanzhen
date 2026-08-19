/**
 * 錄音中的音量視覺化。純函式，不碰 DOM，所以測得到。
 *
 * 這裡的東西只負責「畫成什麼樣子」，**完全不參與任何判斷**。
 * 「有沒有收到聲音」一律由 recorder.ts 的 SILENCE_RMS（0.001）決定，
 * 而那個門檻只抓真正的數位靜音。兩者不要混在一起——
 * 混在一起的那一版真的上線過，症狀是使用者正常講話卻被回「沒有收到聲音」。
 */

/**
 * 條狀音量計的形狀：中間高、兩側低，再加一點**固定的**參差，
 * 讓它看起來像聲音而不是一個對稱三角形。
 *
 * ⚠️ 參差用 index 算，不用亂數——亂數會讓每次 render 的形狀都跳掉。
 */
export const METER_BARS: readonly number[] = Array.from({ length: 21 }, (_, i) => {
  const distance = Math.abs(i - 10) / 10;
  const shape = 1 - distance * distance * 0.75;
  const jitter = 0.8 + ((i * 37) % 11) / 25;
  return shape * jitter;
});

/** 低於這個 RMS 就當成視覺上的零。⚠️ 這是**畫圖**用的底線，不是靜音判斷。 */
const VISUAL_FLOOR = 0.004;
/** 開根號之前的放大倍率。配合下面的 clamp，約 0.05 就滿格。 */
const VISUAL_GAIN = 45;

/**
 * 把 RMS 換成 0~1 的視覺幅度。
 *
 * ⚠️ 開根號不是為了好看，是因為線性對應在這個數值範圍根本看不出變化。
 * 實測（Chrome ＋ 真實麥克風，2026-08-19）：
 *   安靜房間底噪 …… 0.00706
 *   正常說話 ………… 0.009 ~ 0.019
 *   大聲說話 ………… 約 0.05
 * 全部擠在 0~5% 之間，線性畫出來幾乎是一條不動的線。
 */
export function meterAmplitude(level: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, level - VISUAL_FLOOR) * VISUAL_GAIN));
}

/** 單一根柱子的高度（px）。最低留 3px，讓音量計在安靜時仍然看得出是一排柱子。 */
export function meterBarHeight(level: number, factor: number): number {
  return Math.max(3, meterAmplitude(level) * factor * 26);
}
