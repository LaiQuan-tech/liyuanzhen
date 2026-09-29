import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LipSyncPlayer } from "./lipsync-player";
import { TTS_MAX_CHARS } from "./speech-segments";
import { PLAYER_END_GRACE_MS, openSpeechStream, speakWithPlayer } from "./speech-stream";

/**
 * speech-stream.ts：heygen（/live 系列）與 ChibiStage（/live4）共用的「一則答案 → 一條克隆語音串流」。
 *
 * 🔴 鎖的是 2026-09-29 那次改動的驗收：
 * - ≤ 500 字的答案只打一次 /api/tts、body 跟以前一模一樣（正常答案不可以多花任何一次請求）
 * - 長答案切段、依序要、每段 ≤ 600（route 的上限，超過回 400、整段沒聲音）
 * - 第一段要不到就丟錯（呼叫端走原本「整段失敗」那條）；後段失敗串流照常收尾、回報一次
 * - 被打斷不是失敗；重試跟 /chat、/live 同一份
 * - /live4：後段失敗要等她唸完（player.pendingSeconds）才回報；打斷的語意（abort → 什麼都不報）不變
 */

/** n 句、每句 40 字（含句號）。30 句 ＝ 1,200 字 → 切成 480＋480＋240 */
const sentences = (n: number) =>
  Array.from({ length: n }, (_, i) => `第${String(i).padStart(2, "0")}句`.padEnd(39, "婦") + "。").join(
    ""
  );

function bytesStream(...chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new Uint8Array(c));
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const out: number[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(...Array.from(value));
  }
}

function reply(status: number, body: ReadableStream<Uint8Array> | null = null): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: body ?? { cancel: () => Promise.resolve() },
  } as unknown as Response;
}

/** 依序回應的假 fetch；每一次的參數都記下來 */
function scripted(steps: Array<(init: RequestInit) => Promise<Response>>) {
  const calls: { url: string; init: RequestInit; text: string }[] = [];
  const fetchImpl = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, text: JSON.parse(String(init?.body)).text });
    const step = steps[calls.length - 1];
    if (!step) throw new Error(`第 ${calls.length} 次呼叫沒有安排回應`);
    return step(init ?? {});
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = vi.fn(async () => {});

describe("openSpeechStream", () => {
  it("🔴 ≤ 500 字：只打一次，body 跟以前一模一樣（去頭尾空白的全文），拿到的就是那一段的位元組", async () => {
    const { fetchImpl, calls } = scripted([async () => reply(200, bytesStream([1, 2], [3, 4]))]);
    const onSegmentFailed = vi.fn();

    const stream = await openSpeechStream("  婦女新知是 1982 年 2 月創刊的。  ", {
      fetchImpl,
      onSegmentFailed,
    });

    expect(await readAll(stream)).toEqual([1, 2, 3, 4]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/tts");
    expect(calls[0].init.body).toBe(JSON.stringify({ text: "婦女新知是 1982 年 2 月創刊的。" }));
    expect(calls[0].init.method).toBe("POST");
    expect(onSegmentFailed).not.toHaveBeenCalled();
  });

  it("🔴 1,200 字：依序要三段（上一段讀完才要下一段）、每段 ≤ 600、串起來等於原文、位元組依序接好", async () => {
    const { fetchImpl, calls } = scripted([
      async () => reply(200, bytesStream([1, 1])),
      async () => reply(200, bytesStream([2, 2])),
      async () => reply(200, bytesStream([3, 3])),
    ]);
    const text = sentences(30);

    const stream = await openSpeechStream(text, { fetchImpl, onSegmentFailed: vi.fn() });
    expect(calls).toHaveLength(1); // 還沒讀，第二段不會先去要

    expect(await readAll(stream)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.text.length).toBeLessThanOrEqual(TTS_MAX_CHARS);
    expect(calls.map((c) => c.text).join("")).toBe(text);
  });

  it("每一段都帶同一個 signal（念到一半被打斷時，還在飛的那一段一起取消）", async () => {
    const { fetchImpl, calls } = scripted([
      async () => reply(200, bytesStream([1, 1])),
      async () => reply(200, bytesStream([2, 2])),
    ]);
    const abort = new AbortController();

    await readAll(
      await openSpeechStream(sentences(20), { fetchImpl, signal: abort.signal, onSegmentFailed: vi.fn() })
    );

    expect(calls.map((c) => c.init.signal)).toEqual([abort.signal, abort.signal]);
  });

  it("第一段要不到（400）：丟錯，讓呼叫端走原本整段失敗那條；不呼叫 onSegmentFailed、不重試", async () => {
    const { fetchImpl, calls } = scripted([async () => reply(400)]);
    const onSegmentFailed = vi.fn();

    await expect(
      openSpeechStream(sentences(30), { fetchImpl, sleep: noSleep, onSegmentFailed })
    ).rejects.toThrow("TTS 400");
    expect(calls).toHaveLength(1);
    expect(onSegmentFailed).not.toHaveBeenCalled();
  });

  it("第一段一次性的 503：跟 /chat、/live 同一套重試（400ms 之後再要一次）", async () => {
    const waits: number[] = [];
    const { fetchImpl, calls } = scripted([
      async () => reply(503),
      async () => reply(200, bytesStream([9, 9])),
    ]);

    const stream = await openSpeechStream("短答案。", {
      fetchImpl,
      sleep: async (ms) => {
        waits.push(ms);
      },
      onSegmentFailed: vi.fn(),
    });

    expect(await readAll(stream)).toEqual([9, 9]);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([400]);
  });

  it("🔴 後段失敗：串流照常收尾、已經收到的都在，onSegmentFailed 恰好一次（第幾段、共幾段）", async () => {
    const { fetchImpl, calls } = scripted([
      async () => reply(200, bytesStream([1, 1])),
      async () => reply(400),
    ]);
    const onSegmentFailed = vi.fn();

    const stream = await openSpeechStream(sentences(30), { fetchImpl, sleep: noSleep, onSegmentFailed });

    expect(await readAll(stream)).toEqual([1, 1]);
    expect(calls).toHaveLength(2); // 第三段不再要
    expect(onSegmentFailed).toHaveBeenCalledTimes(1);
    expect(onSegmentFailed.mock.calls[0][0]).toBe(1);
    expect(onSegmentFailed.mock.calls[0][1]).toBe(3);
    expect(String(onSegmentFailed.mock.calls[0][2])).toContain("TTS 400");
  });

  it("第一段讀到一半斷掉：也是照常收尾＋onSegmentFailed（index 0），不丟錯", async () => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    const { fetchImpl } = scripted([async () => reply(200, body)]);
    const onSegmentFailed = vi.fn();

    const stream = await openSpeechStream("短答案。", { fetchImpl, onSegmentFailed });
    const done = readAll(stream);
    ctrl.enqueue(new Uint8Array([5, 5]));
    // ⚠️ 先讓讀取端拿走這一塊再斷：同一個 tick 裡 error() 會把還沒讀的佇列整個清掉（串流規格如此）
    await new Promise((r) => setTimeout(r, 0));
    ctrl.error(new Error("network reset"));

    expect(await done).toEqual([5, 5]);
    expect(onSegmentFailed).toHaveBeenCalledTimes(1);
    expect(onSegmentFailed.mock.calls[0][0]).toBe(0);
  });

  it("🔴 被打斷（abort）不是失敗：後面的段落不再要、不呼叫 onSegmentFailed", async () => {
    const { fetchImpl, calls } = scripted([async () => reply(200, bytesStream([1, 1]))]);
    const onSegmentFailed = vi.fn();
    const abort = new AbortController();

    const stream = await openSpeechStream(sentences(30), {
      fetchImpl,
      signal: abort.signal,
      onSegmentFailed,
    });
    const reader = stream.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 1]));
    abort.abort();
    expect((await reader.read()).done).toBe(true);

    expect(calls).toHaveLength(1);
    expect(onSegmentFailed).not.toHaveBeenCalled();
  });

  it("回應在 abort 之後才到（fetch 沒理會 abort）：丟 AbortError、把那條 body cancel 掉", async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    const late = new ReadableStream<Uint8Array>({ cancel });
    const { fetchImpl } = scripted([
      async () => {
        abort.abort();
        return reply(200, late);
      },
    ]);

    await expect(
      openSpeechStream("短答案。", { fetchImpl, signal: abort.signal, onSegmentFailed: vi.fn() })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalled();
  });

  it("onChunk：每一塊交出去之前都會被呼叫（給呼叫端的保險計時器重新計時）", async () => {
    const { fetchImpl } = scripted([async () => reply(200, bytesStream([1, 1], [2, 2], [3, 3]))]);
    const onChunk = vi.fn();

    await readAll(await openSpeechStream("短答案。", { fetchImpl, onChunk, onSegmentFailed: vi.fn() }));

    expect(onChunk).toHaveBeenCalledTimes(3);
  });

  it("沒有要唸的字：丟錯、一次都不打（空字串送去只會換到一個 400）", async () => {
    const { fetchImpl, calls } = scripted([]);
    await expect(openSpeechStream("  \n ", { fetchImpl, onSegmentFailed: vi.fn() })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

// ── speakWithPlayer（/live4 的 ChibiStage）────────────────────

/** 假的 Web Audio：時鐘停在 0，記下每一塊排程的第一個取樣（認得出是哪一則） */
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = "running";
  currentTime = 0;
  destination = {};
  scheduled: string[] = [];
  stoppedSources = 0;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
  createBuffer(_c: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return { duration: length / sampleRate, length, sampleRate, getChannelData: () => data };
  }
  createBufferSource() {
    const ctx = this;
    return {
      buffer: null as null | { getChannelData(): Float32Array },
      onended: null as null | (() => void),
      connect() {},
      disconnect() {},
      stop() {
        ctx.stoppedSources++;
      },
      start() {
        const first = this.buffer ? Math.round(this.buffer.getChannelData()[0] * 32768) : 0;
        ctx.scheduled.push(first === 0x1111 ? "A" : first === 0x2222 ? "B" : `?${first}`);
      },
    };
  }
}
const ctx = () => FakeAudioContext.instances[FakeAudioContext.instances.length - 1];

/** 1 秒 PCM（24kHz、16-bit），每個位元組都是 marker——取樣值就是 0x1111／0x2222 */
const SEC = 48_000;
const second = (marker: number) => new Uint8Array(SEC).fill(marker);

type Responder = (init: RequestInit) => Promise<Response>;
let responders: Responder[];
let calls: { text: string; init: RequestInit }[];

const pcmReply = (marker: number, seconds: number): Responder => async () =>
  ({
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < seconds; i++) c.enqueue(second(marker));
        c.close();
      },
    }),
  }) as unknown as Response;
const statusReply = (status: number): Responder => async () => reply(status);
/** 跟真的 fetch 一樣：一直不回來，被 abort 就丟 AbortError */
const hanging: Responder = (init) =>
  new Promise<Response>((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
/** 回應會到、body 由測試控制；被 abort 時 body 會 error（跟真的 fetch 一樣） */
function controlledReply() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const responder: Responder = async (init) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        init.signal?.addEventListener("abort", () => {
          try {
            c.error(new DOMException("aborted", "AbortError"));
          } catch {
            // 已經關了
          }
        });
      },
    });
    return { ok: true, status: 200, body } as unknown as Response;
  };
  return {
    responder,
    push: (marker: number) => ctrl.enqueue(second(marker)),
    close: () => ctrl.close(),
  };
}

async function drain(turns = 400) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe("speakWithPlayer（/live4 ChibiStage 的編排）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeAudioContext.instances = [];
    responders = [];
    calls = [];
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ text: JSON.parse(String(init.body)).text, init });
      const next = responders.shift();
      if (!next) throw new Error(`第 ${calls.length} 次 /api/tts 沒有安排回應`);
      return next(init);
    });
    vi.stubGlobal("window", { AudioContext: FakeAudioContext });
    vi.stubGlobal("fetch", fakeFetch);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("≤ 500 字：打一次、排進播放圖、不回報；串流收完就 resolve", async () => {
    const player = new LipSyncPlayer();
    const onFailed = vi.fn();
    responders = [pcmReply(0x11, 2)];

    let settled = false;
    const done = speakWithPlayer(player, "  短答案。  ", { signal: new AbortController().signal, onFailed }).then(
      () => (settled = true)
    );
    await drain();

    expect(settled).toBe(true);
    expect(calls.map((c) => c.text)).toEqual(["短答案。"]);
    expect(ctx().scheduled).toEqual(["A", "A"]);
    await done;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("🔴 1,200 字：依序合成三段、全部排進同一個播放圖", async () => {
    const player = new LipSyncPlayer();
    const onFailed = vi.fn();
    responders = [pcmReply(0x11, 1), pcmReply(0x22, 1), pcmReply(0x11, 1)];

    await speakWithPlayer(player, sentences(30), { signal: new AbortController().signal, onFailed });

    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.text.length).toBeLessThanOrEqual(TTS_MAX_CHARS);
    expect(ctx().scheduled).toEqual(["A", "B", "A"]);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("🔴 後段失敗：已經排進去的照播，唸完（pendingSeconds＋寬限）才回報一次；在那之前不 resolve", async () => {
    const player = new LipSyncPlayer();
    const onFailed = vi.fn();
    responders = [pcmReply(0x11, 1), statusReply(400)];

    let settled = false;
    const done = speakWithPlayer(player, sentences(20), { signal: new AbortController().signal, onFailed }).then(
      () => (settled = true)
    );
    await drain();

    expect(ctx().scheduled).toEqual(["A"]);
    expect(onFailed).not.toHaveBeenCalled();
    expect(settled).toBe(false); // ChibiStage 靠這個讓「回答中」撐到回報那一刻

    // 時鐘停在 0：第一段排在 0.08～1.08 秒，再加 250ms 寬限（前後留幾毫秒給浮點誤差）
    const waitMs = 1_080 + PLAYER_END_GRACE_MS;
    await vi.advanceTimersByTimeAsync(waitMs - 5);
    expect(onFailed).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    await done;
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0][0]).toContain("第 2/2 段");
  });

  it("🔴 後段失敗、等著回報時被打斷（訪客按了按鈕）：不回報，promise 立刻收尾", async () => {
    const player = new LipSyncPlayer();
    const onFailed = vi.fn();
    const abort = new AbortController();
    responders = [pcmReply(0x11, 1), statusReply(400)];

    let settled = false;
    const done = speakWithPlayer(player, sentences(20), { signal: abort.signal, onFailed }).then(
      () => (settled = true)
    );
    await drain();
    expect(settled).toBe(false);

    abort.abort(); // ChibiStage.stop()：abort ＋ player.stop()
    player.stop();
    await drain();
    expect(settled).toBe(true);
    await done;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("第一段要不到（400）：停掉 player、立刻回報一次", async () => {
    const player = new LipSyncPlayer();
    const stop = vi.spyOn(player, "stop");
    const onFailed = vi.fn();
    responders = [statusReply(400)];

    await speakWithPlayer(player, "短答案。", { signal: new AbortController().signal, onFailed });

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0][0]).toContain("TTS 400");
    expect(stop).toHaveBeenCalled();
    expect(calls).toHaveLength(1); // 4xx 不重試
  });

  it("503 兩次再成功：重試（400ms、800ms）之後照樣出聲——/live4 以前沒有這一段", async () => {
    const player = new LipSyncPlayer();
    const onFailed = vi.fn();
    responders = [statusReply(503), statusReply(503), pcmReply(0x11, 1)];

    const done = speakWithPlayer(player, "短答案。", { signal: new AbortController().signal, onFailed });
    await drain();
    await vi.advanceTimersByTimeAsync(400);
    await drain();
    await vi.advanceTimersByTimeAsync(800);
    await done;

    expect(calls).toHaveLength(3);
    expect(ctx().scheduled).toEqual(["A"]);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("請求還在飛就被打斷：abort 傳到 fetch、不回報", async () => {
    const player = new LipSyncPlayer();
    const onFailed = vi.fn();
    const abort = new AbortController();
    responders = [hanging];

    const done = speakWithPlayer(player, "短答案。", { signal: abort.signal, onFailed });
    await drain();
    abort.abort();
    await done;

    expect(calls[0].init.signal?.aborted).toBe(true);
    expect(onFailed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("播到一半被打斷（abort ＋ player.stop）：之後不再排程、不回報", async () => {
    const player = new LipSyncPlayer();
    const onFailed = vi.fn();
    const abort = new AbortController();
    const a = controlledReply();
    responders = [a.responder];

    const done = speakWithPlayer(player, "短答案。", { signal: abort.signal, onFailed });
    await drain();
    a.push(0x11);
    await drain();
    expect(ctx().scheduled).toEqual(["A"]);

    abort.abort();
    player.stop();
    await done;
    expect(ctx().scheduled).toEqual(["A"]);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("新的一則蓋過還在讀的舊一則（ChibiStage.finish：abort 舊的、同一個 player 播新的）：只排新的、舊的不回報", async () => {
    const player = new LipSyncPlayer();
    const onFailedA = vi.fn();
    const onFailedB = vi.fn();
    const first = new AbortController();
    const a = controlledReply();
    const b = controlledReply();
    responders = [a.responder, b.responder];

    const doneA = speakWithPlayer(player, "第一題的答案。", { signal: first.signal, onFailed: onFailedA });
    await drain();
    a.push(0x11);
    await drain();
    const mark = ctx().scheduled.length;

    first.abort();
    const doneB = speakWithPlayer(player, "第二題的答案。", {
      signal: new AbortController().signal,
      onFailed: onFailedB,
    });
    await drain();
    b.push(0x22);
    b.push(0x22);
    b.close();
    await Promise.all([doneA, doneB]);

    expect(ctx().scheduled.slice(mark)).toEqual(["B", "B"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onFailedA).not.toHaveBeenCalled();
    expect(onFailedB).not.toHaveBeenCalled();
  });
});
