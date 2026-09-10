import { describe, it, expect } from "vitest";
import {
  LipSyncAnalyser,
  rmsOf,
  visemeForLevel,
  VISEME_ORDER,
} from "@/lib/avatar/lipsync";

/**
 * 對嘴之所以寫成純函式而不是接 AnalyserNode，就是為了能有這一支。
 * 理由寫在 `lib/avatar/lipsync.ts` 的檔頭。
 *
 * ⚠️ 這裡驗的是「時間軸算得對不對」，不是「看起來像不像在講話」。
 * 後者只能用眼睛，在 /chibi 這一頁上看。
 */

/** 造一段 16-bit LE 單聲道 PCM。amplitude 是 0–1 的滿刻度比例 */
function tone(ms: number, amplitude: number, sampleRate = 24000): Uint8Array {
  const n = Math.round((sampleRate * ms) / 1000);
  const bytes = new Uint8Array(n * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) {
    const s = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude * 32767;
    view.setInt16(i * 2, Math.round(s), true);
  }
  return bytes;
}

const silence = (ms: number) => tone(ms, 0);

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

describe("rmsOf", () => {
  it("靜音是 0、滿刻度接近 0.707（正弦波的 RMS）", () => {
    expect(rmsOf(silence(100))).toBe(0);
    expect(rmsOf(tone(100, 1))).toBeGreaterThan(0.69);
    expect(rmsOf(tone(100, 1))).toBeLessThan(0.72);
  });

  it("音量減半，RMS 跟著減半", () => {
    const loud = rmsOf(tone(100, 0.8));
    const quiet = rmsOf(tone(100, 0.4));
    expect(quiet / loud).toBeGreaterThan(0.45);
    expect(quiet / loud).toBeLessThan(0.55);
  });

  /**
   * 🔴 這一條擋的是 `DataView` 少傳 byteOffset。
   * subarray 出來的視窗共用同一塊 buffer，忘了帶 offset 會從別人的資料開始算，
   * 而且不會報錯——只會讓嘴型對到別的地方去。
   */
  it("🔴 subarray 切出來的視窗要從自己的起點算，不是從 buffer 頭", () => {
    const whole = concat([tone(100, 1), silence(100)]);
    const secondHalf = whole.subarray(whole.byteLength / 2);
    expect(secondHalf.byteOffset).toBeGreaterThan(0);
    expect(rmsOf(secondHalf)).toBe(0); // 後半是靜音
  });

  it("空輸入與只有半個樣本都不可以炸", () => {
    expect(rmsOf(new Uint8Array(0))).toBe(0);
    expect(rmsOf(new Uint8Array(1))).toBe(0);
  });
});

describe("visemeForLevel", () => {
  it("由小到大依序是四個嘴型", () => {
    expect(visemeForLevel(0)).toBe("closed");
    expect(visemeForLevel(0.05)).toBe("closed");
    expect(visemeForLevel(0.15)).toBe("small");
    expect(visemeForLevel(0.4)).toBe("mid");
    expect(visemeForLevel(0.9)).toBe("wide");
  });

  it("VISEME_ORDER 是照張開程度排的——播放端靠索引做補間", () => {
    expect(VISEME_ORDER).toEqual(["closed", "small", "mid", "wide"]);
  });
});

describe("LipSyncAnalyser 幀的時間軸", () => {
  it("預設 40ms 一幀：一秒的音訊給 25 幀", () => {
    const a = new LipSyncAnalyser();
    expect(a.frameDurationMs).toBe(40);
    expect(a.push(tone(1000, 0.5))).toHaveLength(25);
  });

  it("atMs 是相對於整段話開頭，跨 chunk continue 累加", () => {
    const a = new LipSyncAnalyser();
    const first = a.push(tone(200, 0.5));
    const second = a.push(tone(200, 0.5));
    expect(first[0].atMs).toBe(0);
    expect(first[first.length - 1].atMs).toBe(160); // 第 5 幀
    expect(second[0].atMs).toBe(200); // 接著算，不是歸零
    expect(second[second.length - 1].atMs).toBe(360);
  });

  it("不滿一幀的資料先留著，湊滿了才吐", () => {
    const a = new LipSyncAnalyser();
    expect(a.push(tone(30, 0.5))).toHaveLength(0); // 不到 40ms
    expect(a.push(tone(30, 0.5))).toHaveLength(1); // 湊成 60ms，吐一幀
  });

  it("flush 把尾巴補成最後一幀——不然句尾嘴會停在張開", () => {
    const a = new LipSyncAnalyser();
    a.push(tone(50, 0.5)); // 一幀 + 10ms 尾巴
    const tail = a.flush();
    expect(tail).toHaveLength(1);
    expect(tail[0].atMs).toBe(40);
    expect(a.flush()).toHaveLength(0); // flush 過就沒了
  });

  it("奇數位元組（半個樣本）不可以炸，也不可以吐出幀", () => {
    const a = new LipSyncAnalyser();
    expect(() => a.push(new Uint8Array(1))).not.toThrow();
    expect(a.flush()).toHaveLength(0);
  });
});

describe("LipSyncAnalyser 嘴型", () => {
  it("整段靜音就整段閉著", () => {
    const a = new LipSyncAnalyser();
    const frames = a.push(silence(500));
    expect(frames.every((f) => f.viseme === "closed")).toBe(true);
    expect(frames.every((f) => f.level === 0)).toBe(true);
  });

  it("持續有聲音時嘴會張開", () => {
    const a = new LipSyncAnalyser();
    const frames = a.push(tone(500, 0.6));
    const open = frames.filter((f) => f.viseme !== "closed");
    expect(open.length).toBeGreaterThan(frames.length * 0.7);
  });

  /**
   * 🔴 這一條是這支測試最重要的一條，擋的是「每個 chunk 各自校準增益」。
   *
   * TTS 是一秒一段串流進來的。如果分析器的狀態沒有跨 chunk 保留，
   * 每一秒的開頭都會重新校準響度，嘴型就會以一秒為週期脈動。
   * 那個瑕疵在單獨看任何一段時都是對的，只有整段接起來才看得出來——
   * 正是最難事後 debug 的那一類。
   */
  it("🔴 同一段音訊，整塊餵和分段餵必須得到一模一樣的時間軸", () => {
    const speech = concat([
      tone(300, 0.7),
      silence(80),
      tone(240, 0.3),
      silence(60),
      tone(400, 0.9),
    ]);

    const whole = new LipSyncAnalyser();
    const atOnce = whole.push(speech).concat(whole.flush());

    // 用一個刻意不對齊幀邊界的大小切開（40ms ＝ 1920 bytes，這裡用 1000）
    const streamed = new LipSyncAnalyser();
    let chunked: ReturnType<LipSyncAnalyser["push"]> = [];
    for (let i = 0; i < speech.byteLength; i += 1000) {
      chunked = chunked.concat(streamed.push(speech.subarray(i, i + 1000)));
    }
    chunked = chunked.concat(streamed.flush());

    expect(chunked).toEqual(atOnce);
  });

  /**
   * ⚠️ 開口快、閉口慢是刻意的不對稱。相同的話，子音之間的短暫低音量
   * 會讓嘴一路閉起來又打開——講一句話嘴巴閉合十幾次，那是金魚不是人。
   */
  it("⚠️ 音節之間的短暫低音量不可以讓嘴完全閉起來", () => {
    const a = new LipSyncAnalyser();
    // 兩個音節中間夾 40ms 的靜音，模擬子音
    const frames = a.push(concat([tone(200, 0.8), silence(40), tone(200, 0.8)]));
    const gapFrame = frames[5]; // 落在那段靜音上
    expect(gapFrame.viseme).not.toBe("closed");
  });

  it("句子講完之後，嘴要真的閉起來", () => {
    const a = new LipSyncAnalyser();
    a.push(tone(300, 0.8));
    const after = a.push(silence(600));
    expect(after[after.length - 1].viseme).toBe("closed");
  });

  /**
   * 自適應增益的意義：同一段話裡她講重點會大聲、補充說明會小聲。
   * 用固定門檻的話小聲那段嘴幾乎不動，看起來像沒在講話。
   */
  it("小聲講話也要有嘴型，不可以因為音量低就當成靜音", () => {
    const a = new LipSyncAnalyser();
    const frames = a.push(tone(800, 0.06)); // 很小聲但不是靜音
    const open = frames.filter((f) => f.viseme !== "closed");
    expect(open.length).toBeGreaterThan(frames.length * 0.5);
  });

  it("level 永遠夾在 0–1", () => {
    const a = new LipSyncAnalyser();
    const frames = a.push(concat([tone(200, 1), silence(100), tone(200, 0.01)]));
    expect(frames.every((f) => f.level >= 0 && f.level <= 1)).toBe(true);
  });

  it("reset 之後從頭算", () => {
    const a = new LipSyncAnalyser();
    a.push(tone(500, 0.8));
    a.reset();
    const frames = a.push(tone(100, 0.8));
    expect(frames[0].atMs).toBe(0);
  });
});
