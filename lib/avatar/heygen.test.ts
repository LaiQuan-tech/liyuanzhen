import { describe, it, expect, vi, afterEach } from "vitest";
import { TTS_MAX_CHARS } from "./speech-segments";

/**
 * heygen driver（/live、/live2、/live3）的打斷、執行期 fatal、長答案分段。
 *
 * 🔴 2026-09-29 查證過、重現過的三組問題，這裡全部寫成守門測試（修前紅、修後綠）：
 *
 * A. stop() 停不掉還在讀的 /api/tts 串流（A1–A6）＋ 20 秒保險在她還在講時報「講完了」（A7）。
 *    舊版 stop() 只 `session.interrupt()`：stop 之後又送 3 塊、兩則的塊交錯（B,A,B,A）、
 *    重試等待中 stop 照樣再送請求、舊串流後來出錯對新的一則報 speechFailed、舊迴圈收尾清掉新一則的保險。
 * B. 執行期 onFatal：收下卻沒送達的答案要先 onSpeechFailed 一次、每個 driver 最多報一次 fatal、
 *    destroy 之後不報、「答案無處可去」要明講。
 * C. 長答案：/api/tts 超過 600 字回 400、4xx 不重試——以前整段一次送，長答案整段沒聲音。
 *
 * 假 SDK ＋ 假 fetch：任何 /api/avatar-token、/api/tts 以外的網址一律丟錯（絕不可以連外、開計費 session）。
 * 所有事件（SDK 指令、回呼）記在同一條 log，看得出先後。
 */

// ── 共用工具 ─────────────────────────────────────────────

/** 由測試控制節奏的串流：push 一塊才吐一塊；被讀取端 cancel 之後再 push 的塊直接丟掉（記數） */
function controlled() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  let dropped = 0;
  return {
    stream,
    push: (bytes: Uint8Array) => {
      if (cancelled) dropped += 1;
      else ctrl.enqueue(bytes);
    },
    close: () => {
      if (!cancelled) ctrl.close();
    },
    error: (e: unknown) => {
      if (!cancelled) ctrl.error(e);
    },
    get dropped() {
      return dropped;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

/** heygen 的 CHUNK_BYTES：1 秒 PCM（24kHz × 16-bit） */
const SEC = 48_000;
const A = 0x11;
const B = 0x22;
const C = 0x33;
const chunk = (marker: number, bytes = SEC) => new Uint8Array(bytes).fill(marker);
const who = (b64: string) => {
  const first = Buffer.from(b64, "base64")[0];
  return first === A ? "A" : first === B ? "B" : first === C ? "C" : `?${first}`;
};

/** 讓 promise 鏈跑完。假時鐘開著的時候改用 advanceTimersByTimeAsync(0)，不然 setTimeout(0) 永遠不會醒 */
const tick = async (n = 4) => {
  for (let i = 0; i < n; i++) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((r) => setTimeout(r, 0));
  }
};
const after = (log: string[], mark: string) => log.slice(log.lastIndexOf(mark) + 1);
/**
 * 假時鐘：setTimeout／clearTimeout **連同 Date** 一起假。
 * 🔴 heygen 估「她什麼時候講完」用的是 Date.now()（第一塊送出的時刻、串流收完的時刻）；
 * 只假計時器、不假 Date 的話，時間點會跟著測試實際跑了幾毫秒飄——不可以靠運氣。
 */
const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
const audioOf = (entries: string[]) =>
  entries.filter((x) => x.startsWith("repeatAudio:")).map((x) => x.slice("repeatAudio:".length));
/** 只看回報給呼叫端的三種事件 */
const reportsOf = (entries: string[]) =>
  entries.filter((x) => x.startsWith("speaking:") || x === "speechFailed" || x.startsWith("fatal"));

/** 一條已經收尾的串流（不帶參數 ＝ 空的） */
const bytesOf = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(x);
      c.close();
    },
  });

type Responder = (init: RequestInit) => Response | Promise<Response>;

const streamResponse = (s: ReadableStream<Uint8Array>): Responder => () => new Response(s, { status: 200 });
const statusResponse = (status: number): Responder => () =>
  new Response(JSON.stringify({ error: "x" }), { status });
/** 一段已經生好的 PCM（marker 填滿），每秒一塊 */
const pcm = (marker: number, seconds: number): Responder => () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < seconds; i++) c.enqueue(chunk(marker));
        c.close();
      },
    }),
    { status: 200 }
  );
/** 跟真的 fetch 一樣：一直不回來，被 abort 就丟 AbortError */
const hangingUntilAbort: Responder = (init) =>
  new Promise<Response>((_, reject) => {
    init.signal?.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError"))
    );
  });

interface HarnessOptions {
  /** start() 的行為。預設：立刻成功並發 stream_ready（跟真的 SDK 一樣在 start 之後） */
  start?: (api: { emit: (event: string, arg?: unknown) => void }) => Promise<void>;
  /** true：/api/avatar-token 卡住，直到測試 releaseToken(status) */
  gateToken?: boolean;
}

async function makeHeygen(options: HarnessOptions = {}) {
  const log: string[] = [];
  const listeners = new Map<string, (arg?: unknown) => void>();
  const emit = (event: string, arg?: unknown) => listeners.get(event)?.(arg);
  let sessions = 0;

  class FakeSession {
    readonly mode = "LITE";
    constructor() {
      sessions += 1;
    }
    on(e: string, cb: (arg?: unknown) => void) {
      listeners.set(e, cb);
    }
    once(e: string, cb: (arg?: unknown) => void) {
      listeners.set(e, cb);
    }
    async start() {
      if (options.start) return options.start({ emit });
      emit("session_stream_ready");
    }
    attach() {
      log.push("attach");
    }
    interrupt() {
      log.push("interrupt");
    }
    repeat(t: string) {
      log.push("repeat:" + t);
    }
    repeatAudio(b64: string) {
      log.push("repeatAudio:" + who(b64));
    }
    async stop() {
      log.push("session.stop");
      // 真的 SDK 收線時也會發斷線事件（CLIENT_INITIATED）
      emit("session_disconnected", "CLIENT_INITIATED");
    }
  }
  vi.resetModules();
  vi.doMock("@heygen/liveavatar-web-sdk", () => ({
    LiveAvatarSession: FakeSession,
    SessionEvent: {
      SESSION_STREAM_READY: "session_stream_ready",
      SESSION_DISCONNECTED: "session_disconnected",
    },
    AgentEventsEnum: {
      AVATAR_SPEAK_STARTED: "avatar_speak_started",
      AVATAR_SPEAK_ENDED: "avatar_speak_ended",
    },
  }));

  let releaseToken: (status: number) => void = () => {};
  const tokenGate = new Promise<number>((resolve) => (releaseToken = resolve));
  let tokenRequests = 0;
  const tts: { text: string; body: string; init: RequestInit }[] = [];
  const responders: Responder[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/avatar-token")) {
      tokenRequests += 1;
      const status = options.gateToken ? await tokenGate : 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ reason: "budget_exhausted" }), { status });
      }
      return new Response(JSON.stringify({ sessionToken: "t", maxSessionSeconds: 180 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url).includes("/api/tts")) {
      const body = String(init?.body);
      const text = JSON.parse(body).text as string;
      tts.push({ text, body, init: init ?? {} });
      log.push("fetch:" + (text.length <= 20 ? text : `${text.length}字`));
      const r = responders.shift();
      if (!r) throw new Error("測試沒有準備這一次 /api/tts 的回應");
      return r(init ?? {});
    }
    // 任何其他網址一律擋下：這支測試絕不可以連外（真 SDK 會打 LiveAvatar API、開計費 session）
    throw new Error("沒有預期到的請求：" + url);
  });

  let speechFailed = 0;
  let fatal = 0;
  const { createHeygenDriver } = await import("./heygen");
  const driver = createHeygenDriver({
    onSpeakingChange: (s) => log.push("speaking:" + s),
    onFatal: (e) => {
      fatal += 1;
      log.push("fatal:" + e.message);
    },
    onSpeechFailed: () => {
      speechFailed += 1;
      log.push("speechFailed");
    },
  });
  return {
    driver,
    log,
    tts,
    responders,
    emit,
    releaseToken,
    failed: () => speechFailed,
    fatals: () => fatal,
    sessions: () => sessions,
    tokenRequests: () => tokenRequests,
  };
}

const VIDEO = {} as unknown as HTMLVideoElement;

/** 已接通的 heygen driver */
async function connectedHeygen() {
  const h = await makeHeygen();
  await h.driver.prepare(VIDEO);
  // 治具自檢：假 SDK 真的有接上（沒接上的話 prepare 會 onFatal，log 裡會有 fatal:）
  if (h.log.some((x) => x.startsWith("fatal:")) || !h.log.includes("attach")) {
    throw new Error("治具錯誤：" + h.log.join(" | "));
  }
  return h;
}

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("@heygen/liveavatar-web-sdk");
  vi.resetModules();
  vi.unstubAllGlobals();
});

// ── A：打斷 ──────────────────────────────────────────────

describe("A. stop() 與還在讀的 /api/tts 串流（D4／D5）", () => {
  it("A0 對照組（沒有 stop）：治具正常，4 塊全部送出、請求帶著 signal", async () => {
    const h = await connectedHeygen();
    const a = controlled();
    h.responders.push(streamResponse(a.stream));

    h.driver.finish("答案一");
    await tick();
    for (let i = 0; i < 4; i++) a.push(chunk(A));
    a.close();
    await tick();

    expect(audioOf(h.log)).toEqual(["A", "A", "A", "A"]);
    expect(h.tts[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(h.failed()).toBe(0);
    await h.driver.destroy();
  });

  it("A1 串流讀到一半 stop()：之後不可以再 repeatAudio，串流要被取消、請求要被 abort", async () => {
    const h = await connectedHeygen();
    const a = controlled();
    h.responders.push(streamResponse(a.stream));

    h.driver.finish("答案一");
    await tick();
    a.push(chunk(A)); // 第 1 秒：stop 之前已經送進去
    await tick();
    expect(audioOf(h.log)).toEqual(["A"]);

    h.log.push("--stop--");
    h.driver.stop();
    await tick();
    // 立刻取消，不是等下一塊到了才發現自己過期（伺服器那一側可以早點收手，也不再佔著連線）
    expect(a.cancelled).toBe(true);
    for (let i = 0; i < 3; i++) {
      a.push(chunk(A)); // 伺服器還在吐的第 2～4 秒
      await tick();
    }
    a.close();
    await tick();

    expect(audioOf(after(h.log, "--stop--"))).toEqual([]);
    expect(a.cancelled).toBe(true);
    expect(h.tts[0].init.signal?.aborted).toBe(true);
    // 被打斷不是失敗
    expect(h.failed()).toBe(0);
    await h.driver.destroy();
  });

  it("A1b stop() 時手上還有不足一秒的殘塊：那一截也不可以在 stop 之後送出去", async () => {
    const h = await connectedHeygen();
    const a = controlled();
    h.responders.push(streamResponse(a.stream));

    h.driver.finish("答案一");
    await tick();
    a.push(chunk(A, SEC + SEC / 4)); // 1.25 秒：送出 1 秒，0.25 秒留在手上等湊滿
    await tick();
    expect(audioOf(h.log)).toEqual(["A"]);

    h.log.push("--stop--");
    h.driver.stop();
    await tick();
    // ⚠️ 一定要讓串流收尾：殘塊只在「串流結束」那一刻才會被當成句尾送出去。
    // 不關的話，舊版的迴圈會一直等下一塊，這條測試對任何寫法都是綠的（空轉）。
    a.close();
    await tick();

    // 舊版：串流一結束就把殘塊當「句尾」送出去——被打斷的答案又冒出 0.25 秒
    expect(audioOf(after(h.log, "--stop--"))).toEqual([]);
    await h.driver.destroy();
  });

  it("A2 /api/tts 還沒回應（首字延遲那 1～3.6 秒）就 stop()：回應晚到也不可以開口", async () => {
    const h = await connectedHeygen();
    const a = controlled();
    let release!: (r: Response) => void;
    // 不理會 abort 的回應（已經在路上的那種）：由測試決定什麼時候到
    h.responders.push(() => new Promise<Response>((r) => (release = r)));

    h.driver.finish("答案一");
    await tick();
    h.log.push("--stop--");
    h.driver.stop();
    await tick();

    release(new Response(a.stream, { status: 200 }));
    await tick();
    a.push(chunk(A));
    await tick();
    a.push(chunk(A));
    a.close();
    await tick();

    expect(audioOf(after(h.log, "--stop--"))).toEqual([]);
    expect(a.cancelled).toBe(true); // 晚到的串流直接丟掉
    expect(h.failed()).toBe(0);
    await h.driver.destroy();
  });

  it("A3 stop() 之後馬上說新的一則：兩則的塊不可以交錯", async () => {
    const h = await connectedHeygen();
    const a = controlled();
    const b = controlled();
    h.responders.push(streamResponse(a.stream), streamResponse(b.stream));

    h.driver.finish("答案一");
    await tick();
    a.push(chunk(A));
    await tick();

    h.driver.stop();
    h.driver.finish("答案二");
    await tick();
    h.log.push("--B-started--");

    // 兩條串流都還在吐（答案一的後半截、答案二的開頭）
    for (let i = 0; i < 3; i++) {
      b.push(chunk(B));
      await tick();
      a.push(chunk(A));
      await tick();
    }
    a.close();
    b.close();
    await tick();

    expect(audioOf(after(h.log, "--B-started--"))).toEqual(["B", "B", "B"]);
    await h.driver.destroy();
  });

  it("A3b 沒有 stop、直接說新的一則（下一題蓋過去）：舊的一樣要停，只送新的", async () => {
    const h = await connectedHeygen();
    const a = controlled();
    const b = controlled();
    h.responders.push(streamResponse(a.stream), streamResponse(b.stream));

    h.driver.finish("答案一");
    await tick();
    a.push(chunk(A));
    await tick();

    h.driver.finish("答案二");
    await tick();
    h.log.push("--B-started--");
    for (let i = 0; i < 2; i++) {
      a.push(chunk(A));
      await tick();
      b.push(chunk(B));
      await tick();
    }

    expect(audioOf(after(h.log, "--B-started--"))).toEqual(["B", "B"]);
    expect(a.cancelled).toBe(true);
    expect(h.tts[0].init.signal?.aborted).toBe(true);
    expect(h.failed()).toBe(0);
    await h.driver.destroy();
  });

  it("A4 第一次 503、在重試的等待中 stop()：不可以再送第二次、不可以出聲", async () => {
    const h = await connectedHeygen();
    const a = controlled();
    h.responders.push(statusResponse(503), streamResponse(a.stream));

    h.driver.finish("答案一");
    await tick(); // 第一次 503 → 進入 400ms 的等待
    h.log.push("--stop--");
    h.driver.stop();
    await new Promise((r) => setTimeout(r, 500));
    await tick();

    expect(h.tts.length).toBe(1);
    expect(audioOf(after(h.log, "--stop--"))).toEqual([]);
    expect(h.failed()).toBe(0);
    await h.driver.destroy();
  });

  it("A5 舊的一則串流在新的一則進行中斷線：不可以對新的一則報 speechFailed／speaking:false", async () => {
    const h = await connectedHeygen();
    const a = controlled();
    const b = controlled();
    h.responders.push(streamResponse(a.stream), streamResponse(b.stream));

    h.driver.finish("答案一");
    await tick();
    a.push(chunk(A));
    await tick();
    h.driver.stop();
    h.driver.finish("答案二");
    await tick();
    b.push(chunk(B));
    await tick();

    h.log.push("--A-errors--");
    a.error(new Error("network reset")); // 被打斷的那一則，連線後來斷掉
    await tick();

    const post = after(h.log, "--A-errors--");
    expect(post).not.toContain("speechFailed");
    expect(post).not.toContain("speaking:false");
    b.close();
    await h.driver.destroy();
  });

  it("A6 舊的一則晚於新的一則收尾：不可以清掉新一則的保險、改用舊的長度", async () => {
    const h = await connectedHeygen();
    fakeClock();
    const a = controlled();
    const b = controlled();
    h.responders.push(streamResponse(a.stream), streamResponse(b.stream));

    h.driver.finish("答案一");
    await tick();
    a.push(chunk(A)); // 答案一：只有 1 秒
    await tick();
    h.driver.stop();
    h.driver.finish("答案二");
    await tick();
    for (let i = 0; i < 10; i++) b.push(chunk(B)); // 答案二：10 秒
    b.close(); // 答案二先收完 → 保險 = 10 + 2 = 12 秒
    await tick();
    h.log.push("--A-closes--");
    a.close(); // 被打斷的答案一這時才收完（舊版會清掉 12 秒那條、改成 1 + 2 = 3 秒）
    await tick();

    await vi.advanceTimersByTimeAsync(3_300);
    expect(after(h.log, "--A-closes--")).not.toContain("speaking:false");
    // 答案二自己的保險照常在 12 秒收掉
    await vi.advanceTimersByTimeAsync(9_000);
    expect(after(h.log, "--A-closes--")).toContain("speaking:false");
    expect(h.failed()).toBe(0);
    await h.driver.destroy();
  });

  /**
   * 300 字 ≈ 60 秒語音，2.25 倍實時 ≈ 26.7 秒生成 ＋ 首字 3.6 秒 ≈ 30 秒才讀完。
   * 舊版的 20 秒保險只在「整條讀完」才換掉，第 20 秒就報 speaking:false——她才講到第 16 秒。
   */
  it("A7 串流要讀 30 秒：還在收到塊的時候，20 秒保險不可以報 speaking:false；收完之後照估計的講完時間收", async () => {
    const h = await connectedHeygen();
    const a = controlled();
    h.responders.push(streamResponse(a.stream));
    fakeClock();

    h.driver.finish("三百字的長答案");
    await vi.advanceTimersByTimeAsync(3_600); // 首字延遲
    let falseDuringRead = false;
    for (let i = 0; i < 60; i++) {
      a.push(chunk(A)); // 每 444ms 生出 1 秒音訊（2.25 倍實時）
      await vi.advanceTimersByTimeAsync(444);
      if (h.log.includes("speaking:false")) falseDuringRead = true;
    }
    a.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(audioOf(h.log)).toHaveLength(60);
    expect(falseDuringRead).toBe(false);
    // 收完（第 30.24 秒）之後的保險：她第 3.6 秒開始講、60 秒音訊 → 63.6 秒講完，＋2 秒寬限 ＝ 第 65.6 秒。
    // （舊版從收完起算：30.24＋60＋2 ＝ 第 92.24 秒，晚了將近半分鐘。）
    await vi.advanceTimersByTimeAsync(65_600 - 30_240 - 50);
    expect(h.log).not.toContain("speaking:false");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.log).toContain("speaking:false");
    expect(h.failed()).toBe(0);
    await h.driver.destroy();
  });

  it("A8 串流 20 秒都沒有任何新資料：保險照舊把「回答中」收掉（D5 只改「有資料時不可以觸發」）", async () => {
    const h = await connectedHeygen();
    h.responders.push(hangingUntilAbort);
    fakeClock();

    h.driver.finish("卡住的合成");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.log).not.toContain("speaking:false");
    await vi.advanceTimersByTimeAsync(2);
    expect(h.log).toContain("speaking:false");
    await h.driver.destroy();
  });

  it("A9 destroy() 時還在要語音：請求 abort、不回報 speechFailed", async () => {
    const h = await connectedHeygen();
    h.responders.push(hangingUntilAbort);

    h.driver.finish("卸載前的最後一則");
    await tick();
    await h.driver.destroy();
    await tick();

    expect(h.tts[0].init.signal?.aborted).toBe(true);
    expect(h.failed()).toBe(0);
    expect(h.fatals()).toBe(0);
  });
});

// ── B：執行期 fatal ───────────────────────────────────────

describe("B. 執行期 onFatal：收下卻沒送達的答案先 onSpeechFailed 一次、fatal 每個 driver 一次（D3）", () => {
  it("B1 連線中有答案在排隊、斷線：speechFailed×1 → fatal×1，排隊的那則不會在之後冒出來、session 會被收掉", async () => {
    let releaseStart!: () => void;
    const gate = new Promise<void>((r) => (releaseStart = r));
    const h = await makeHeygen({
      start: async ({ emit }) => {
        await gate;
        emit("session_stream_ready");
      },
    });

    const ready = h.driver.prepare(VIDEO);
    await tick();
    h.driver.finish("排隊的答案");
    h.log.push("--disconnect--");
    h.emit("session_disconnected", "UNKNOWN_REASON");

    expect(reportsOf(after(h.log, "--disconnect--"))).toEqual([
      "speechFailed",
      "fatal:LiveAvatar session 斷線：UNKNOWN_REASON",
    ]);

    releaseStart();
    await ready;
    await tick();
    expect(h.failed()).toBe(1);
    expect(h.fatals()).toBe(1);
    expect(h.log).not.toContain("speaking:true");
    expect(h.tts).toHaveLength(0);
    expect(h.log).toContain("session.stop"); // 報過 fatal 的連線不留著計費
  });

  it("B2 連線中有答案在排隊、token 被拒（prepare 失敗）：speechFailed×1 → fatal×1", async () => {
    const h = await makeHeygen({ gateToken: true });

    const ready = h.driver.prepare(VIDEO);
    await tick();
    h.driver.finish("排隊的答案");
    h.releaseToken(503);
    await ready;

    expect(reportsOf(h.log)).toEqual(["speechFailed", "fatal:取得 avatar token 失敗（503 budget_exhausted）"]);
    expect(h.sessions()).toBe(0);
    expect(h.tts).toHaveLength(0);
  });

  it("B3 start() 失敗（SDK 先發斷線事件再丟例外）：只報一次 fatal", async () => {
    const h = await makeHeygen({
      start: async ({ emit }) => {
        emit("session_disconnected", "SESSION_START_FAILED");
        throw new Error("start failed");
      },
    });

    await h.driver.prepare(VIDEO);

    expect(h.fatals()).toBe(1);
    expect(h.failed()).toBe(0); // 沒有答案在手上
  });

  it("B3b start() 失敗、而且有答案在排隊：speechFailed 與 fatal 都恰好一次", async () => {
    let releaseStart!: () => void;
    const gate = new Promise<void>((r) => (releaseStart = r));
    const h = await makeHeygen({
      start: async ({ emit }) => {
        await gate;
        emit("session_disconnected", "SESSION_START_FAILED");
        throw new Error("start failed");
      },
    });

    const ready = h.driver.prepare(VIDEO);
    await tick();
    h.driver.finish("排隊的答案");
    releaseStart();
    await ready;

    expect(reportsOf(h.log)).toEqual(["speechFailed", "fatal:LiveAvatar session 斷線：SESSION_START_FAILED"]);
  });

  it("B4 正在要語音（/api/tts 還沒回應）時斷線：收掉說話狀態 → speechFailed×1 → fatal×1，請求 abort", async () => {
    const h = await connectedHeygen();
    h.responders.push(hangingUntilAbort);

    h.driver.finish("合成中的答案");
    await tick();
    expect(h.log).toContain("speaking:true");
    h.log.push("--disconnect--");
    h.emit("session_disconnected", "UNKNOWN_REASON");
    await tick();

    expect(reportsOf(after(h.log, "--disconnect--"))).toEqual([
      "speaking:false",
      "speechFailed",
      "fatal:LiveAvatar session 斷線：UNKNOWN_REASON",
    ]);
    expect(h.tts[0].init.signal?.aborted).toBe(true);
  });

  it("B5 正在送塊（串流讀到一半）時斷線：speechFailed×1 → fatal×1，串流取消、之後不再送", async () => {
    const h = await connectedHeygen();
    const a = controlled();
    h.responders.push(streamResponse(a.stream));

    h.driver.finish("講到一半的答案");
    await tick();
    a.push(chunk(A));
    await tick();
    h.log.push("--disconnect--");
    h.emit("session_disconnected", "UNKNOWN_REASON");
    a.push(chunk(A));
    await tick();

    expect(reportsOf(after(h.log, "--disconnect--"))).toEqual([
      "speaking:false",
      "speechFailed",
      "fatal:LiveAvatar session 斷線：UNKNOWN_REASON",
    ]);
    expect(audioOf(after(h.log, "--disconnect--"))).toEqual([]);
    expect(a.cancelled).toBe(true);
  });

  it("B6 塊都送完了、她還在講（還沒 speak_ended、保險還沒到）時斷線：speechFailed×1 → fatal×1", async () => {
    const h = await connectedHeygen();
    fakeClock(); // 保險（3 秒音訊＋2 秒）一定還沒到，不靠實際經過的毫秒數
    h.responders.push(pcm(A, 3));

    h.driver.finish("送完了還在講的答案");
    await tick();
    expect(audioOf(h.log)).toEqual(["A", "A", "A"]);
    h.log.push("--disconnect--");
    h.emit("session_disconnected", "UNKNOWN_REASON");

    expect(reportsOf(after(h.log, "--disconnect--"))).toEqual([
      "speaking:false",
      "speechFailed",
      "fatal:LiveAvatar session 斷線：UNKNOWN_REASON",
    ]);
    await h.driver.destroy();
  });

  it("B7 講完之後（收到 speak_ended）才斷線：只有 fatal", async () => {
    const h = await connectedHeygen();
    h.responders.push(pcm(A, 1));

    h.driver.finish("已經講完的答案");
    await tick();
    h.emit("avatar_speak_ended");
    expect(h.log.at(-1)).toBe("speaking:false");
    h.log.push("--disconnect--");
    h.emit("session_disconnected", "UNKNOWN_REASON");

    expect(reportsOf(after(h.log, "--disconnect--"))).toEqual([
      "fatal:LiveAvatar session 斷線：UNKNOWN_REASON",
    ]);
    expect(h.failed()).toBe(0);
  });

  it("B7b 講完之後（沒有 speak_ended，靠音訊長度的保險收）才斷線：只有 fatal", async () => {
    const h = await connectedHeygen();
    fakeClock();
    h.responders.push(pcm(A, 1));

    h.driver.finish("已經講完的答案");
    await tick();
    await vi.advanceTimersByTimeAsync(3_000); // 1 秒音訊＋2 秒寬限
    expect(h.log.at(-1)).toBe("speaking:false");
    h.log.push("--disconnect--");
    h.emit("session_disconnected", "UNKNOWN_REASON");

    expect(reportsOf(after(h.log, "--disconnect--"))).toEqual([
      "fatal:LiveAvatar session 斷線：UNKNOWN_REASON",
    ]);
    expect(h.failed()).toBe(0);
  });

  it("B7c 被 stop() 打斷之後才斷線：只有 fatal（被打斷的那則不算沒送達）", async () => {
    const h = await connectedHeygen();
    const a = controlled();
    h.responders.push(streamResponse(a.stream));

    h.driver.finish("被打斷的答案");
    await tick();
    a.push(chunk(A));
    await tick();
    h.driver.stop();
    h.log.push("--disconnect--");
    h.emit("session_disconnected", "UNKNOWN_REASON");

    expect(reportsOf(after(h.log, "--disconnect--"))).toEqual([
      "fatal:LiveAvatar session 斷線：UNKNOWN_REASON",
    ]);
  });

  it("B8 閒置時斷線：只有 fatal；重複的斷線事件也只報一次", async () => {
    const h = await connectedHeygen();
    h.emit("session_disconnected", "SERVER_INITIATED");
    h.emit("session_disconnected", "UNKNOWN_REASON");

    expect(reportsOf(h.log)).toEqual(["fatal:LiveAvatar session 斷線：SERVER_INITIATED"]);
  });

  it("B9 destroy() 之後才失敗的 prepare（切分頁收掉之後 token 才被拒）：不報 fatal", async () => {
    const h = await makeHeygen({ gateToken: true });

    const ready = h.driver.prepare(VIDEO);
    await tick();
    h.driver.finish("排隊的答案");
    await h.driver.destroy();
    h.releaseToken(503);
    await ready;

    expect(h.fatals()).toBe(0);
    expect(h.failed()).toBe(0);
  });

  it("B9b 我們自己 destroy()（SDK 回一個 CLIENT_INITIATED 斷線）：不報 fatal、不報 speechFailed", async () => {
    const h = await connectedHeygen();
    h.responders.push(hangingUntilAbort);
    h.driver.finish("講到一半被收掉");
    await tick();

    await h.driver.destroy();
    await tick();

    expect(h.log).toContain("session.stop");
    expect(h.fatals()).toBe(0);
    expect(h.failed()).toBe(0);
  });

  it("B10 答案無處可去（沒在連、也沒連上）：onSpeechFailed，不可以只寫 trace", async () => {
    const h = await makeHeygen();
    h.driver.finish("沒有人在等這句話");

    expect(h.failed()).toBe(1);
    expect(h.fatals()).toBe(0);
    expect(h.tts).toHaveLength(0);
    expect(h.log).not.toContain("speaking:true");
  });

  it("B11 prepare(null)（沒有 <video>）走同一個去重的回報：再呼叫一次也不會報第二次", async () => {
    const h = await makeHeygen();
    await h.driver.prepare(null);
    await h.driver.prepare(null);

    expect(h.fatals()).toBe(1);
    expect(h.failed()).toBe(0);
    expect(h.tokenRequests()).toBe(0);
  });

  it("B13 合成回了 200 但一個取樣都沒有：明講（speechFailed×1）、說話狀態收回，不是無聲又零解釋", async () => {
    const h = await connectedHeygen();
    h.responders.push(streamResponse(bytesOf()));

    h.driver.finish("空的音訊");
    await tick();

    expect(reportsOf(h.log)).toEqual(["speaking:true", "speaking:false", "speechFailed"]);
    expect(audioOf(h.log)).toEqual([]);
  });

  it("B12 報過 fatal、還沒被收掉的 driver：finish 明講沒聲音、prepare 不會再去要 token", async () => {
    const h = await connectedHeygen();
    h.emit("session_disconnected", "UNKNOWN_REASON");

    h.driver.finish("斷線之後才到的答案");
    await h.driver.prepare(VIDEO);

    expect(h.failed()).toBe(1);
    expect(h.fatals()).toBe(1);
    expect(h.tts).toHaveLength(0);
    expect(h.tokenRequests()).toBe(1);
  });
});

// ── C：長答案分段 ─────────────────────────────────────────

/** n 句、每句 40 字（含句號）。30 句 ＝ 1,200 字 → 切成 480＋480＋240 */
const sentences = (n: number) =>
  Array.from({ length: n }, (_, i) => `第${String(i).padStart(2, "0")}句`.padEnd(39, "婦") + "。").join(
    ""
  );

describe("C. 長答案分段（D6）", () => {
  it("🔴 C1 ≤ 500 字：只打一次 /api/tts，body 跟以前一模一樣（去頭尾空白的全文）", async () => {
    const h = await connectedHeygen();
    h.responders.push(pcm(A, 1));

    h.driver.finish("  婦女新知是 1982 年 2 月創刊的。  ");
    await tick();

    expect(h.tts).toHaveLength(1);
    expect(h.tts[0].body).toBe(JSON.stringify({ text: "婦女新知是 1982 年 2 月創刊的。" }));
    expect(h.tts[0].init.method).toBe("POST");
    expect(h.tts[0].init.headers).toEqual({ "Content-Type": "application/json" });
    expect(audioOf(h.log)).toEqual(["A"]);
    await h.driver.destroy();
  });

  it("C1b 剛好 500 字一次、501 字才切兩段", async () => {
    const h = await connectedHeygen();
    h.responders.push(pcm(A, 1));
    const exactly500 = "婦".repeat(500);
    h.driver.finish(exactly500);
    await tick();
    expect(h.tts.map((t) => t.text)).toEqual([exactly500]);

    h.responders.push(pcm(A, 1), pcm(B, 1));
    h.driver.finish("婦".repeat(501));
    await tick(8);
    expect(h.tts.slice(1).map((t) => t.text.length)).toEqual([500, 1]);
    await h.driver.destroy();
  });

  it("🔴 C2 1,200 字：依序打三次（上一段收完才要下一段）、每段 ≤ 600、串起來等於原文、送進 avatar 的順序正確", async () => {
    const h = await connectedHeygen();
    const s1 = controlled();
    const s2 = controlled();
    const s3 = controlled();
    h.responders.push(streamResponse(s1.stream), streamResponse(s2.stream), streamResponse(s3.stream));
    const text = sentences(30);

    h.driver.finish(text);
    await tick();
    expect(h.tts).toHaveLength(1); // 第二段還沒去要

    s1.push(chunk(A));
    s1.push(chunk(A));
    s1.close();
    await tick();
    expect(h.tts).toHaveLength(2);

    s2.push(chunk(B));
    s2.close();
    await tick();
    expect(h.tts).toHaveLength(3);

    s3.push(chunk(C));
    s3.close();
    await tick();

    for (const t of h.tts) expect(t.text.length).toBeLessThanOrEqual(TTS_MAX_CHARS);
    expect(h.tts.map((t) => t.text).join("")).toBe(text);
    expect(audioOf(h.log)).toEqual(["A", "A", "B", "C"]);
    // 每一段都帶同一個 signal（被打斷時一起取消）
    expect(new Set(h.tts.map((t) => t.init.signal)).size).toBe(1);
    expect(h.failed()).toBe(0);
    expect(h.log).not.toContain("speaking:false");
    await h.driver.destroy();
  });

  it("🔴 C3 第二段失敗：第一段照送；speak_ended 來了也不收說話狀態，估計講完時才一起收掉＋speechFailed 恰一次", async () => {
    const h = await connectedHeygen();
    fakeClock();
    h.responders.push(pcm(A, 1), statusResponse(400));

    h.driver.finish(sentences(20)); // 800 字 → 兩段
    await tick(8);

    expect(h.tts).toHaveLength(2);
    expect(audioOf(h.log)).toEqual(["A"]);
    expect(h.failed()).toBe(0); // 她還在講第一段，不在這時候跳提示

    await vi.advanceTimersByTimeAsync(1_500);
    h.log.push("--speak-ended--");
    h.emit("avatar_speak_ended"); // 她講完第一段
    // 🔴 什麼都不報：「回答中」要撐到回報那一刻，這段期間訪客按下去，LiveStage 才會 stop() 把回報一起取消
    expect(reportsOf(after(h.log, "--speak-ended--"))).toEqual([]);

    // 第一塊第 0 秒送出、1 秒音訊 → 1 秒講完，＋2 秒寬限 ＝ 第 3 秒
    await vi.advanceTimersByTimeAsync(1_499);
    expect(h.failed()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(reportsOf(after(h.log, "--speak-ended--"))).toEqual(["speaking:false", "speechFailed"]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.failed()).toBe(1);
    expect(h.fatals()).toBe(0);
    await h.driver.destroy();
  });

  it("🔴 C3d 後段失敗、串流收完、speak_ended 已到，回報之前被打斷（LiveStage 看到 speaking 仍是 true 而 stop()）：不回報", async () => {
    const h = await connectedHeygen();
    fakeClock();
    h.responders.push(pcm(A, 1), statusResponse(400));

    h.driver.finish(sentences(20));
    await tick(8);
    await vi.advanceTimersByTimeAsync(1_500);
    h.emit("avatar_speak_ended");

    // 訪客這時候按下一題：LiveStage.press() 只在 speaking 是 true 時才 stop()
    const lastSpeaking = h.log.filter((x) => x.startsWith("speaking:")).at(-1);
    expect(lastSpeaking).toBe("speaking:true");
    h.log.push("--press--");
    h.driver.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(reportsOf(after(h.log, "--press--"))).toEqual(["speaking:false"]);
    expect(h.failed()).toBe(0); // 被打斷不是失敗，提示不可以掛到下一輪
    await h.driver.destroy();
  });

  it("🔴 C3e 串流比實時快（正常情況）：回報在「第一塊送出＋音訊總長＋寬限」，不是「收完＋總長＋寬限」", async () => {
    const h = await connectedHeygen();
    fakeClock();
    const s1 = controlled();
    h.responders.push(streamResponse(s1.stream), statusResponse(400));

    h.driver.finish(sentences(20));
    await vi.advanceTimersByTimeAsync(3_600); // 首字延遲：第一塊第 3.6 秒才到
    for (let i = 0; i < 10; i++) {
      s1.push(chunk(A)); // 每 444ms 生出 1 秒音訊（2.25 倍實時）
      await vi.advanceTimersByTimeAsync(444);
    }
    s1.close(); // 第 8.04 秒收完 → 第二段 400 → 整條收尾
    await tick();
    expect(audioOf(h.log)).toHaveLength(10);
    expect(h.tts).toHaveLength(2);

    // 她第 3.6 秒開始講、10 秒音訊 → 第 13.6 秒講完，回報在第 15.6 秒
    // （舊版：8.04＋10＋2 ＝ 第 20.04 秒——那時她已經安靜了 6 秒多）
    await vi.advanceTimersByTimeAsync(15_600 - 8_040 - 50);
    expect(h.failed()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.failed()).toBe(1);
    await h.driver.destroy();
  });

  it("🔴 C3f 串流比實時慢（每一塊到的時候上一塊早就講完了）：回報在「最後一塊送出＋它的長度＋寬限」", async () => {
    const h = await connectedHeygen();
    fakeClock();
    const s1 = controlled();
    h.responders.push(streamResponse(s1.stream), statusResponse(400));

    h.driver.finish(sentences(20));
    await tick();
    s1.push(chunk(A)); // 第 0 秒：她開始講這 1 秒
    await vi.advanceTimersByTimeAsync(2_000);
    s1.push(chunk(A)); // 第 2 秒：上一塊早就講完了，這一塊現在才開始
    await vi.advanceTimersByTimeAsync(2_000);
    s1.push(chunk(A)); // 第 4 秒
    s1.close();
    await tick();
    expect(audioOf(h.log)).toHaveLength(3);

    // 講完 ≈ 第 4 秒＋1 秒 ＝ 第 5 秒，回報在第 7 秒。
    // （舊版：收完 4＋總長 3＋2 ＝ 第 9 秒；只看「第一塊＋總長」會是 0＋3＋2 ＝ 第 5 秒，她還在講就報）
    await vi.advanceTimersByTimeAsync(3_000 - 50);
    expect(h.failed()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.failed()).toBe(1);
    await h.driver.destroy();
  });

  it("C3b 後段失敗、還沒回報就被 stop() 打斷：不回報（被打斷不是失敗）", async () => {
    const h = await connectedHeygen();
    fakeClock();
    h.responders.push(pcm(A, 1), statusResponse(400));

    h.driver.finish(sentences(20));
    await tick(8);
    h.driver.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.failed()).toBe(0);
    await h.driver.destroy();
  });

  it("C3c 後段失敗、還沒回報就斷線：fatal 時照樣報 speechFailed 恰一次（不會等到之後再報第二次）", async () => {
    const h = await connectedHeygen();
    fakeClock();
    h.responders.push(pcm(A, 1), statusResponse(400));

    h.driver.finish(sentences(20));
    await tick(8);
    h.emit("avatar_speak_ended");
    h.emit("session_disconnected", "UNKNOWN_REASON");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.failed()).toBe(1);
    expect(h.fatals()).toBe(1);
  });

  it("🔴 C4 念到一半 stop()：第二段還在飛的請求要 abort，第三段不再要，也不回報失敗", async () => {
    const h = await connectedHeygen();
    h.responders.push(pcm(A, 1), hangingUntilAbort);

    h.driver.finish(sentences(30));
    await tick(8);
    expect(h.tts).toHaveLength(2);

    h.driver.stop();
    await tick(8);

    expect(h.tts).toHaveLength(2);
    expect(h.tts[1].init.signal?.aborted).toBe(true);
    expect(h.failed()).toBe(0);
    await h.driver.destroy();
  });

  it("C4b 第一段還在讀就 stop()：第二段根本不去要", async () => {
    const h = await connectedHeygen();
    const s1 = controlled();
    h.responders.push(streamResponse(s1.stream));

    h.driver.finish(sentences(30));
    await tick();
    s1.push(chunk(A));
    await tick();
    h.driver.stop();
    s1.push(chunk(A));
    s1.close();
    await tick(8);

    expect(h.tts).toHaveLength(1);
    expect(audioOf(h.log)).toEqual(["A"]);
    expect(h.failed()).toBe(0);
    await h.driver.destroy();
  });

  it("C5 後面的段落也走同一套重試：503 之後補回來，照樣念完", async () => {
    const h = await connectedHeygen();
    fakeClock();
    h.responders.push(pcm(A, 1), statusResponse(503), pcm(B, 1));

    h.driver.finish(sentences(20));
    await tick(8);
    await vi.advanceTimersByTimeAsync(400);
    await tick(8);

    expect(h.tts.map((t) => t.text.length)).toEqual([480, 320, 320]);
    expect(audioOf(h.log)).toEqual(["A", "B"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.failed()).toBe(0);
    await h.driver.destroy();
  });
});
