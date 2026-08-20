import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * 錄音器的行為測試（不是 classifyRecording 那種純函式測試）。
 *
 * ⚠️ 這一組守的是重寫之後那條最重要的界線：
 * **音量計壞掉不可以害錄音壞掉。**
 *
 * 舊版把 AudioContext 放在錄音的關鍵路徑上（worklet 就是取樣來源），
 * 於是「自動播放政策讓 context 停在 suspended」這種跟收音完全無關的事
 * 會讓整段話錄不到，而畫面上看起來就是「按住說話沒反應」。
 * 現在 AudioContext 只負責畫柱子，它整個炸掉，話還是要錄得到、送得出去。
 */

class FakeMediaRecorder {
  static supportedTypes = ["audio/webm;codecs=opus"];
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(type: string) {
    return FakeMediaRecorder.supportedTypes.includes(type);
  }

  state = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  /** 這一次 stop() 要吐出幾個位元組。測「只有標頭」的情況時調小。 */
  payloadBytes = 9_000;

  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    // 真的 MediaRecorder 是先 ondataavailable 再 onstop，順序不能顛倒
    this.ondataavailable?.({ data: new Blob([new Uint8Array(this.payloadBytes)]) });
    this.onstop?.();
  }
}

class FakeAudioContext {
  static mode: "running" | "suspended" | "throw" = "running";
  state: string;
  constructor() {
    if (FakeAudioContext.mode === "throw") throw new Error("AudioContext 被擋下");
    this.state = FakeAudioContext.mode;
  }
  async resume() {}
  createMediaStreamSource() {
    return { connect: () => {} };
  }
  createAnalyser() {
    return {
      fftSize: 1024,
      getFloatTimeDomainData: (buf: Float32Array) => buf.fill(0.05),
    };
  }
  async close() {}
}

let track: { stop: ReturnType<typeof vi.fn>; muted: boolean; readyState: string };
/** getUserMedia 要拖多久才 resolve。測「還沒拿到麥克風就放開」時調大。 */
let micDelayMs = 0;

function installFakes() {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.supportedTypes = ["audio/webm;codecs=opus"];
  FakeAudioContext.mode = "running";
  micDelayMs = 0;
  track = { stop: vi.fn(), muted: false, readyState: "live" };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };

  // ⚠️ 一律走 vi.stubGlobal：node 的 navigator 是只有 getter 的全域，直接指派會丟 TypeError
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: () =>
        new Promise((resolve) => setTimeout(() => resolve(stream), micDelayMs)),
    },
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("AudioContext", FakeAudioContext);
}

let createRecorder: typeof import("./recorder").createRecorder;

beforeEach(async () => {
  installFakes();
  vi.resetModules();
  ({ createRecorder } = await import("./recorder"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("錄音器", () => {
  it("正常一輪：拿到 blob、mimeType 來自 recorder 而不是寫死", async () => {
    const recorder = createRecorder();
    await recorder.start();
    expect(recorder.recording).toBe(true);

    await wait(250);
    const outcome = await recorder.stop();

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.mimeType).toBe("audio/webm;codecs=opus");
    expect(outcome.blob.size).toBe(9_000);
    expect(track.stop).toHaveBeenCalled();
  });

  it("🔴 音量計整個炸掉，錄音仍然要成功", async () => {
    // 這就是舊架構死掉的方式：AudioContext 出事 ＝ 整段話錄不到。
    FakeAudioContext.mode = "throw";
    const recorder = createRecorder();
    await recorder.start();
    await wait(250);
    const outcome = await recorder.stop();

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    // ⚠️ peak 必須是 null（不知道），不可以是 0（靜音）——
    // 回 0 的話呼叫端會判定「沒有收到聲音」，把講了話的人擋下來。
    expect(outcome.peak).toBeNull();
  });

  it("🔴 AudioContext 停在 suspended 時，peak 是「不知道」而不是 0", async () => {
    FakeAudioContext.mode = "suspended";
    const recorder = createRecorder();
    await recorder.start();
    await wait(250);
    const outcome = await recorder.stop();

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.peak).toBeNull();
  });

  it("音量計正常時要回得出真的峰值", async () => {
    const levels: number[] = [];
    const recorder = createRecorder({ onLevel: (rms) => levels.push(rms) });
    await recorder.start();
    await wait(250);
    const outcome = await recorder.stop();

    expect(levels.some((l) => l > 0)).toBe(true);
    if (outcome.kind !== "ok") return;
    expect(outcome.peak).toBeCloseTo(0.05, 3);
  });

  it("🔴 還沒拿到麥克風就放開 ＝ 麥克風不可以留在開著的狀態", async () => {
    // 防護一。少了它，稍後才 resolve 的 stream 會變成孤兒——
    // 分頁的錄音紅點一直亮著，而畫面上看起來一切正常。
    micDelayMs = 120;
    const recorder = createRecorder();
    const starting = recorder.start();
    const outcome = await recorder.stop();
    await starting.catch(() => {});
    await wait(200);

    expect(outcome.kind).toBe("aborted");
    expect(track.stop).toHaveBeenCalled();
  });

  it("start() 期間再按一次，不可以開出第二個 MediaRecorder", async () => {
    // 防護二
    micDelayMs = 60;
    const recorder = createRecorder();
    const a = recorder.start();
    const b = recorder.start();
    await Promise.all([a, b]);

    expect(FakeMediaRecorder.instances).toHaveLength(1);
    await recorder.stop();
  });

  it("音軌自己說 muted，就回 no-audio", async () => {
    const recorder = createRecorder();
    await recorder.start();
    track.muted = true;
    await wait(250);

    expect((await recorder.stop()).kind).toBe("no-audio");
  });

  it("按住夠久卻只吐得出標頭，也是 no-audio", async () => {
    const recorder = createRecorder();
    await recorder.start();
    FakeMediaRecorder.instances[0].payloadBytes = 300;
    await wait(600);

    expect((await recorder.stop()).kind).toBe("no-audio");
  });

  it("瀏覽器不支援指定容器時，交給它自己挑（Safari 走這條）", async () => {
    FakeMediaRecorder.supportedTypes = [];
    const recorder = createRecorder();
    await recorder.start();
    await wait(250);
    const outcome = await recorder.stop();

    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.mimeType).toBe("audio/webm"); // 假的 MediaRecorder 的預設
  });
});
