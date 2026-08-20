import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * 錄音管線的行為測試（不是 classifyRecording 那種純函式測試）。
 *
 * ⚠️ 為什麼值得為了測這個而假造半個 Web Audio API：
 * 「按住說話沒反應」修到第五輪還在發生，而其中**兩輪**的成因都在這幾行——
 * 一次是「一塊都沒收到」被誤判成誤觸，一次是「重接一次」那條路
 * 因為順手呼叫了 teardown() 而永遠失敗。兩次都是讀程式碼才發現的，
 * 因為 node 環境跑不起來 AudioContext，所以這一段長期沒有任何測試覆蓋。
 *
 * 假造的範圍刻意只到「能不能跑起來、有沒有收到音訊」為止，
 * 不模擬取樣內容——那是 wav.test.ts 的事。
 */

class FakeWorkletNode {
  port: { onmessage: ((e: { data: Float32Array }) => void) | null; close: () => void } = {
    onmessage: null,
    close: () => {},
  };
  constructor(context: FakeAudioContext) {
    context.node = this;
  }
  disconnect() {}
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = "running";
  sampleRate = 48_000;
  closed = false;
  node: FakeWorkletNode | null = null;
  audioWorklet = { addModule: async () => {} };

  constructor() {
    FakeAudioContext.instances.push(this);
  }
  async resume() {
    this.state = "running";
  }
  createMediaStreamSource() {
    return { connect: () => {}, disconnect: () => {} };
  }
  async close() {
    this.closed = true;
  }
}

/** 這一次 getUserMedia 交出去的那條 track。stop 有沒有被呼叫是本檔的核心斷言之一。 */
let track: { stop: ReturnType<typeof vi.fn> };

function installFakes() {
  FakeAudioContext.instances = [];
  track = { stop: vi.fn() };
  // ⚠️ 一律走 vi.stubGlobal：node 的 `navigator` 是只有 getter 的全域，
  // 直接指派會丟 TypeError。afterEach 的 unstubAllGlobals 也才收得乾淨。
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) },
  });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  // URL 本身要留著（Blob URL 以外的地方還在用），只補上 worklet 需要的兩支
  URL.createObjectURL = () => "blob:fake";
  URL.revokeObjectURL = () => {};
}

/** 讓等待中的 promise 排空。fake timer 之下 await 一次不夠，內部有多層 await。 */
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function emitChunk() {
  const ctx = FakeAudioContext.instances[FakeAudioContext.instances.length - 1];
  ctx.node?.port.onmessage?.({ data: new Float32Array(4096).fill(0.05) });
}

let createRecorder: typeof import("./recorder").createRecorder;

beforeEach(async () => {
  vi.useFakeTimers();
  installFakes();
  vi.resetModules();
  ({ createRecorder } = await import("./recorder"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("錄音管線", () => {
  it("🔴 start() 不可以等第一塊音訊——按下去要立刻進入錄音狀態", async () => {
    // 前一版把「等第一塊音訊」放在 start() 的 await 路徑上，於是按下按鈕之後
    // 最多 700ms 畫面完全沒有反應（按鈕還寫著「按住說話」、音量計不出現）。
    // 使用者的結論只會是「壞了」，然後放開再按一次，把正常的那一輪也中斷掉。
    const recorder = createRecorder();
    const started = recorder.start();
    await flush();

    // 一塊音訊都還沒送出來，但錄音必須已經開始
    expect(recorder.recording).toBe(true);
    await started;
  });

  it("🔴 收不到音訊時重接，**不可以**把 stream 一起關掉", async () => {
    // 這就是那個 bug：重接前呼叫了 teardown()，它會 stop 掉每一條 track 並把
    // stream 設成 null，於是重接的第一行 `if (!stream) return false` 直接失敗。
    // 「重試一次」從來沒有真的執行過，每次都是丟 MicrophoneError("unavailable")，
    // 畫面顯示「找不到可用的麥克風」——既嚇人又指著錯的方向。
    const onNoAudio = vi.fn();
    const recorder = createRecorder({ onNoAudio });
    await recorder.start();
    await flush();
    expect(FakeAudioContext.instances).toHaveLength(1);

    // 700ms 內一塊都沒送 → 看門狗回收 AudioContext 重接
    await vi.advanceTimersByTimeAsync(700);
    await flush();

    expect(FakeAudioContext.instances).toHaveLength(2); // 真的重建了
    expect(FakeAudioContext.instances[0].closed).toBe(true); // 舊的收乾淨
    expect(track.stop).not.toHaveBeenCalled(); // 🔴 麥克風不可以被關掉
    expect(recorder.recording).toBe(true); // 錄音沒有中斷
    expect(onNoAudio).not.toHaveBeenCalled(); // 還沒到宣告失敗的時候
  });

  it("重接之後收得到音訊，就當成正常的一次錄音", async () => {
    const onNoAudio = vi.fn();
    const recorder = createRecorder({ onNoAudio });
    await recorder.start();
    await flush();

    await vi.advanceTimersByTimeAsync(700);
    await flush();
    // ⚠️ 要送滿 MIN_RECORDING_SECONDS（0.2s）。一塊是 4096 取樣 ＝ 48kHz 下 0.085 秒，
    // 只送一塊會正確地被判成 too-short，那不是 bug。
    for (let i = 0; i < 3; i++) emitChunk();

    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await recorder.stop();

    expect(outcome.kind).toBe("ok");
    expect(onNoAudio).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled(); // 這一次才該關麥克風
  });

  it("重接之後仍然收不到，才在訪客還在講的時候提醒他", async () => {
    const onNoAudio = vi.fn();
    const recorder = createRecorder({ onNoAudio });
    await recorder.start();
    await flush();

    await vi.advanceTimersByTimeAsync(700); // 第一次逾時 → 重接
    await flush();
    await vi.advanceTimersByTimeAsync(700); // 重接後又逾時 → 宣告失敗
    await flush();

    expect(onNoAudio).toHaveBeenCalledTimes(1);
    // ⚠️ 提醒歸提醒，錄音**不中止**——萬一只是這條回報路徑判斷錯了，
    // 也不該替使用者決定他那句話不算數。
    expect(recorder.recording).toBe(true);

    const outcome = await recorder.stop();
    expect(outcome.kind).toBe("no-audio");
  });

  it("音量回呼要拿得到真實 RMS，不是只有 0", async () => {
    const levels: number[] = [];
    const recorder = createRecorder({ onLevel: (rms) => levels.push(rms) });
    await recorder.start();
    await flush();
    emitChunk();

    expect(levels[0]).toBeCloseTo(0.05, 3);
  });

  it("放開時一律關掉麥克風——錄音紅點不可以留在分頁上", async () => {
    const recorder = createRecorder();
    await recorder.start();
    await flush();
    emitChunk();
    await vi.advanceTimersByTimeAsync(500);
    await recorder.stop();

    expect(track.stop).toHaveBeenCalled();
  });
});
