import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LipSyncPlayer } from "@/lib/avatar/lipsync-player";

/**
 * `LipSyncPlayer` 的排程層測試。
 *
 * 🔴 這一支存在的理由要寫清楚：實作時這四件事**是驗過的**，但驗它的測試檔
 * 當初是寫成暫時檔、驗完就刪了。也就是說最難查的那幾個坑一度沒有任何防護。
 * 它們共同的特徵是「壞掉的時候不會報錯，只會表現成嘴型怪怪的」——
 * 那正是最需要自動化擋住、最不能靠眼睛驗收的一類。
 *
 * ⚠️ 這裡驗的是時間軸算得對不對，不是聽起來對不對。後者只能在 /chibi 上用耳朵。
 */

const SAMPLE_RATE = 24000;

/** 記錄每一次 createBuffer 的內容與排程時刻，測試靠它檢查 */
interface Scheduled {
  startedAt: number;
  samples: Float32Array;
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  state = "running";
  currentTime = 0;
  destination = {};
  scheduled: Scheduled[] = [];
  closed = false;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  resume() {
    this.state = "running";
    return Promise.resolve();
  }

  close() {
    this.closed = true;
    return Promise.resolve();
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return {
      duration: length / sampleRate,
      length,
      sampleRate,
      getChannelData: () => data,
    };
  }

  createBufferSource() {
    const ctx = this;
    return {
      buffer: null as null | { getChannelData(): Float32Array; duration: number },
      onended: null as null | (() => void),
      connect() {},
      disconnect() {},
      stop() {},
      start(at: number) {
        ctx.scheduled.push({
          startedAt: at,
          samples: this.buffer ? this.buffer.getChannelData() : new Float32Array(0),
        });
      },
    };
  }
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  vi.stubGlobal("window", { AudioContext: FakeAudioContext });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ctxOf = (player: LipSyncPlayer): FakeAudioContext => {
  void player;
  return FakeAudioContext.instances[FakeAudioContext.instances.length - 1];
};

/** 造一段 16-bit LE PCM，樣本值是可預測的遞增序列，方便逐一比對 */
function rampPcm(sampleCount: number, start = 0): Uint8Array {
  const bytes = new Uint8Array(sampleCount * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < sampleCount; i++) {
    // 在 Int16 範圍內繞圈，避免溢位
    view.setInt16(i * 2, (((start + i) * 37) % 20000) - 10000, true);
  }
  return bytes;
}

function streamOf(chunks: Uint8Array[], onPull?: (index: number) => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      onPull?.(i);
      controller.enqueue(chunks[i++]);
    },
  });
}

/** 把所有排程過的 buffer 接起來，還原成 Int16 序列 */
function replaySamples(ctx: FakeAudioContext): number[] {
  const out: number[] = [];
  for (const s of ctx.scheduled) {
    for (let i = 0; i < s.samples.length; i++) {
      out.push(Math.round(s.samples[i] * 32768));
    }
  }
  return out;
}

function expectedSamples(pcm: Uint8Array): number[] {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out: number[] = [];
  for (let i = 0; i < Math.floor(pcm.byteLength / 2); i++) out.push(view.getInt16(i * 2, true));
  return out;
}

describe("LipSyncPlayer 取樣對齊", () => {
  /**
   * 🔴 串流的切點跟 16-bit 取樣邊界沒有任何關係。
   * 少處理半個 byte，之後每一個 byte 都會錯位一格——高低位元組互換，
   * 整段從語音變成刺耳雜訊。而且不會有任何錯誤訊息。
   */
  it("🔴 每一塊都切在奇數位元組上，重建出來的取樣仍要與原始資料完全一致", async () => {
    const whole = rampPcm(3000);
    // 三個切點全是奇數，強迫每一塊都留下半個取樣
    const chunks = [whole.subarray(0, 1001), whole.subarray(1001, 3504), whole.subarray(3504)];
    expect(chunks[0].byteLength % 2).toBe(1);

    const player = new LipSyncPlayer();
    await player.play(streamOf(chunks));

    expect(replaySamples(ctxOf(player))).toEqual(expectedSamples(whole));
  });

  it("整條串流只有一個奇數位元組（永遠湊不滿）時，不可以炸也不可以吐出取樣", async () => {
    const player = new LipSyncPlayer();
    await player.play(streamOf([new Uint8Array([0x7f])]));
    expect(ctxOf(player).scheduled).toHaveLength(0);
  });
});

describe("LipSyncPlayer 斷流後的時間軸", () => {
  /**
   * 🔴 這是實作時最難查的一個，也是最值得留著的一條。
   *
   * 直覺寫法是「時間軸 = 整段話的開頭時間 ＋ atMs」。那在沒有斷流時才成立。
   * 真實情況是網路會卡：卡超過 LEAD 之後，`Math.max(currentTime + LEAD, nextAt)`
   * 會把下一塊往後推，音訊之間多出一段靜音——於是「第 5 秒的取樣」實際上
   * 5.3 秒才出聲，而嘴型還照 5 秒算，會愈跑愈前面。
   *
   * 正解是每一塊自己算原點。這條測試就是在鎖那件事。
   */
  it("🔴 讀取卡住 5 秒之後，第二塊的排程與嘴型都要跟著往後跳", async () => {
    const player = new LipSyncPlayer();
    const chunkA = rampPcm(2400); // 100ms
    const chunkB = rampPcm(2400, 5000);

    let ctx: FakeAudioContext | undefined;
    const stream = streamOf([chunkA, chunkB], (index) => {
      // 第二塊被讀到之前，播放時鐘已經走了 5 秒（模擬網路卡住）
      if (index === 1) {
        ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1];
        if (ctx) ctx.currentTime = 5;
      }
    });

    await player.play(stream);
    const c = ctxOf(player);

    expect(c.scheduled).toHaveLength(2);
    // 第一塊排在 LEAD(0.08) 上；第二塊不是接在 0.18，而是被推到 5.08
    expect(c.scheduled[0].startedAt).toBeCloseTo(0.08, 5);
    expect(c.scheduled[1].startedAt).toBeCloseTo(5.08, 5);

    // 關鍵：第二塊產生的嘴型必須落在 5 秒之後，而不是接在第一塊後面
    c.currentTime = 5.1;
    expect(player.currentViseme().viseme).not.toBe("closed");

    // 而在那段靜音的正中間，時間軸上不該有任何格子
    c.currentTime = 2.5;
    expect(player.currentViseme()).toEqual({ viseme: "closed", level: 0 });
  });

  it("沒有斷流時，兩塊要無縫相接", async () => {
    const player = new LipSyncPlayer();
    await player.play(streamOf([rampPcm(2400), rampPcm(2400, 5000)]));
    const c = ctxOf(player);
    expect(c.scheduled[0].startedAt).toBeCloseTo(0.08, 5);
    expect(c.scheduled[1].startedAt).toBeCloseTo(0.18, 5); // 0.08 + 100ms
  });
});

describe("LipSyncPlayer currentViseme 的邊界", () => {
  it("還沒開始播、以及已經講完，都要回 closed / 0", async () => {
    const player = new LipSyncPlayer();
    await player.play(streamOf([rampPcm(4800)])); // 200ms
    const c = ctxOf(player);

    c.currentTime = 0; // 第一塊排在 0.08，還沒到
    expect(player.currentViseme()).toEqual({ viseme: "closed", level: 0 });

    c.currentTime = 999; // 早就講完
    expect(player.currentViseme()).toEqual({ viseme: "closed", level: 0 });
  });

  it("完全沒播放過就問，不可以炸", () => {
    expect(new LipSyncPlayer().currentViseme()).toEqual({ viseme: "closed", level: 0 });
  });

  it("播放中查得到時間軸上的格子", async () => {
    const player = new LipSyncPlayer();
    await player.play(streamOf([rampPcm(24000)])); // 一秒
    const c = ctxOf(player);
    c.currentTime = 0.5;
    const state = player.currentViseme();
    expect(state.level).toBeGreaterThan(0);
    expect(state.viseme).not.toBe("closed");
  });
});

describe("LipSyncPlayer stop 與 onFirstAudio", () => {
  it("stop 之後時間軸清空，問嘴型一律 closed", async () => {
    const player = new LipSyncPlayer();
    await player.play(streamOf([rampPcm(24000)]));
    const c = ctxOf(player);
    c.currentTime = 0.5;
    expect(player.currentViseme().viseme).not.toBe("closed");

    player.stop();
    expect(player.currentViseme()).toEqual({ viseme: "closed", level: 0 });
    expect(player.isPlaying).toBe(false);
  });

  it("onFirstAudio 只在第一塊排進去時觸發一次", async () => {
    const player = new LipSyncPlayer();
    const spy = vi.fn();
    await player.play(streamOf([rampPcm(1200), rampPcm(1200), rampPcm(1200)]), spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠️ 只有半個取樣的那一塊不算「有聲音」——如果在那時候就通報，
   * 量到的首字延遲會比實際出聲早，那個數字會拿去做決策，不能虛報。
   */
  it("⚠️ 湊不滿一個取樣的第一塊不可以就通報 onFirstAudio", async () => {
    const player = new LipSyncPlayer();
    const spy = vi.fn();
    const calls: number[] = [];
    await player.play(
      streamOf([new Uint8Array([0x11]), rampPcm(1200)], (i) => calls.push(i)),
      () => spy(calls.length)
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(2); // 第二塊被讀到之後才通報
  });

  it("重播會先把上一段停乾淨，時間軸不會累積", async () => {
    const player = new LipSyncPlayer();
    await player.play(streamOf([rampPcm(24000)]));
    const firstCount = ctxOf(player).scheduled.length;
    await player.play(streamOf([rampPcm(2400)]));
    // 同一個 fake context 會累積 scheduled，但時間軸應該只剩第二段的長度
    ctxOf(player).currentTime = 0.5;
    expect(firstCount).toBeGreaterThan(0);
    expect(player.currentViseme()).toEqual({ viseme: "closed", level: 0 }); // 第二段只有 100ms
  });
});
