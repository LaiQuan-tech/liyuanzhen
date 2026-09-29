import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { canPlayClonedVoice, createMonogramDriver } from "./monogram";
import { createAvatarDriver, resolveProvider } from "./index";
import { TTS_MAX_CHARS } from "./speech-segments";
import type { AvatarDriverHooks } from "./types";

/**
 * monogram driver：/chat 的朗讀（正式站預設）與語音頁的備援。
 *
 * 🔴 2026-09-29 從裝置內建語音改成老師的克隆聲（/api/tts → LipSyncPlayer）。
 * 這裡鎖的是那次改動的每一條驗收：預設就是克隆聲、長答案切段念完、失敗走 onSpeechFailed
 * 而不是換別的聲音、不會卡在「回答中」、打斷時請求會被取消、AudioContext 只在手勢裡開。
 *
 * ⚠️ 瀏覽器的自動播放政策在自動化瀏覽器裡是放行的，驗不出「沒手勢開出來的 context 是啞的」
 * 這類 bug——所以那幾條只能在這裡用假的 AudioContext 把判斷鎖住。
 */

// ── 假的 Web Audio ─────────────────────────────────────────

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** 新開的 context 一開始是什麼狀態 */
  static initialState = "running";
  /** false ＝ 模擬「沒有手勢」：resume() 永遠不 resolve */
  static resumeWorks = true;

  state: string;
  currentTime = 0;
  destination = {};
  scheduled: { startedAt: number; duration: number }[] = [];
  stoppedSources = 0;
  closed = false;

  constructor() {
    this.state = FakeAudioContext.initialState;
    FakeAudioContext.instances.push(this);
  }

  resume() {
    if (!FakeAudioContext.resumeWorks) return new Promise<void>(() => {});
    this.state = "running";
    return Promise.resolve();
  }

  close() {
    this.closed = true;
    this.state = "closed";
    return Promise.resolve();
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return { duration: length / sampleRate, length, sampleRate, getChannelData: () => data };
  }

  createBufferSource() {
    const ctx = this;
    return {
      buffer: null as null | { duration: number },
      onended: null as null | (() => void),
      connect() {},
      disconnect() {},
      stop() {
        ctx.stoppedSources++;
      },
      start(at: number) {
        ctx.scheduled.push({ startedAt: at, duration: this.buffer ? this.buffer.duration : 0 });
      },
    };
  }
}

const ctx = () => FakeAudioContext.instances[FakeAudioContext.instances.length - 1];

// ── 假的 /api/tts ──────────────────────────────────────────

type Responder = (signal?: AbortSignal) => Promise<Response>;

let responders: Responder[];
let calls: { text: string; signal?: AbortSignal }[];
let fakeFetch: ReturnType<typeof vi.fn>;

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** 200 ＋ 一段裸 PCM（全是 0 的取樣），分幾塊送；被 abort 時 body 會 error，跟真的 fetch 一樣 */
function pcm(seconds: number, chunks = 4): Responder {
  return async (signal) => {
    const total = Math.round(seconds * 24_000) * 2;
    const size = Math.max(2, Math.ceil(total / chunks / 2) * 2);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => {
          try {
            controller.error(abortError());
          } catch {
            // 已經關了
          }
        });
      },
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        const n = Math.min(size, total - sent);
        controller.enqueue(new Uint8Array(n));
        sent += n;
      },
    });
    return { ok: true, status: 200, body } as unknown as Response;
  };
}

function status(code: number): Responder {
  return async () => ({ ok: false, status: code, body: null }) as unknown as Response;
}

function networkError(): Responder {
  return async () => Promise.reject(new TypeError("Failed to fetch"));
}

/** 永遠不回來，直到被 abort——模擬卡住的合成請求 */
function hanging(): Responder {
  return (signal) =>
    new Promise<Response>((_, reject) => {
      signal?.addEventListener("abort", () => reject(abortError()));
    });
}

/**
 * 不理 abort、由測試決定什麼時候才回來的 200（模擬 fetch 沒有真的被取消）。
 * body 是 5 塊、共 0.5 秒的 PCM；cancel 會被記下來。
 * ⚠️ 一定要有盡頭：沒盡頭的話，守門一壞掉這條就是無限讀取把測試行程撐爆，而不是一個看得懂的斷言失敗。
 */
function lateIgnoringAbort() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const cancel = vi.fn();
  const responder: Responder = async () => {
    await gate;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 5) {
          controller.close();
          return;
        }
        sent++;
        controller.enqueue(new Uint8Array(4800));
      },
      cancel,
    });
    return { ok: true, status: 200, body } as unknown as Response;
  };
  return { responder, release, cancel };
}

/** 20 句、每句 40 字 ＝ 800 字：切成兩段（480＋320） */
const TWO_SEGMENTS = Array.from(
  { length: 20 },
  (_, i) => `第${String(i).padStart(2, "0")}句`.padEnd(39, "婦") + "。"
).join("");

/** 由測試決定什麼時候回來 */
function deferred() {
  let release!: (responder: Responder) => void;
  const gate = new Promise<Responder>((resolve) => (release = resolve));
  const responder: Responder = async (signal) => (await gate)(signal);
  return { responder, release };
}

// ── 小工具 ────────────────────────────────────────────────

function makeHooks() {
  const speaking: boolean[] = [];
  const fatal: Error[] = [];
  const failed = vi.fn();
  const hooks: AvatarDriverHooks = {
    onSpeakingChange: (s) => speaking.push(s),
    onFatal: (e) => fatal.push(e),
    onSpeechFailed: failed,
  };
  return { hooks, speaking, fatal, failed };
}

/** 讓 promise 鏈（fetch → 串流 → 排程）跑完。串流每一塊都要好幾個 microtask。 */
async function drain(turns = 2000) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** 一個已經在手勢裡解鎖過的 driver */
function unlockedDriver() {
  const h = makeHooks();
  const driver = createMonogramDriver(h.hooks);
  driver.unlockAudio?.();
  return { driver, ...h };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeAudioContext.instances = [];
  FakeAudioContext.initialState = "running";
  FakeAudioContext.resumeWorks = true;
  responders = [];
  calls = [];
  fakeFetch = vi.fn((_url: string, init: RequestInit) => {
    calls.push({ text: JSON.parse(String(init.body)).text, signal: init.signal ?? undefined });
    const next = responders.shift();
    if (!next) throw new Error(`第 ${calls.length} 次 /api/tts 沒有安排回應`);
    return next(init.signal ?? undefined);
  });
  vi.stubGlobal("window", { AudioContext: FakeAudioContext, fetch: fakeFetch, ReadableStream });
  vi.stubGlobal("fetch", fakeFetch);
  // trace() 在有 window 時會印 console，測試不需要看
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── 測試 ──────────────────────────────────────────────────

describe("canPlayClonedVoice", () => {
  it("要 Web Audio ＋ fetch ＋ ReadableStream，缺一就是 false", () => {
    const fn = () => {};
    expect(canPlayClonedVoice(undefined)).toBe(false);
    expect(canPlayClonedVoice({})).toBe(false);
    expect(canPlayClonedVoice({ AudioContext: fn, fetch: fn, ReadableStream: fn })).toBe(true);
    expect(canPlayClonedVoice({ AudioContext: fn, ReadableStream: fn })).toBe(false);
    expect(canPlayClonedVoice({ AudioContext: fn, fetch: fn })).toBe(false);
  });

  it("Safari 舊版只有 webkit 前綴也算", () => {
    const fn = () => {};
    expect(canPlayClonedVoice({ webkitAudioContext: fn, fetch: fn, ReadableStream: fn })).toBe(true);
  });
});

describe("預設設定就是克隆聲", () => {
  it("🔴 NEXT_PUBLIC_AVATAR_PROVIDER 沒設 → monogram → 朗讀打的是 /api/tts（不用改任何環境變數）", async () => {
    const { hooks } = makeHooks();
    const driver = await createAvatarDriver(hooks, resolveProvider(undefined));
    expect(driver.provider).toBe("monogram");
    expect(driver.needsVideo).toBe(false);
    expect(driver.metered).toBe(false);

    responders = [pcm(0.2)];
    driver.unlockAudio?.();
    driver.finish("婦女新知是 1982 年 2 月創刊的。");
    await drain();

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(fakeFetch.mock.calls[0][0]).toBe("/api/tts");
    expect(ctx().scheduled.length).toBeGreaterThan(0);
  });
});

describe("AudioContext 只在手勢裡開", () => {
  it("🔴 prepare() 不開 AudioContext——AvatarStage 在掛載時（沒有手勢）就會呼叫它", async () => {
    const { hooks } = makeHooks();
    const driver = createMonogramDriver(hooks);
    await driver.prepare(null);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(driver.audioAvailable).toBe(true);
  });

  it("unlockAudio() 開一個，重複呼叫（每次送出都會叫）不會多開", () => {
    const { driver } = unlockedDriver();
    driver.unlockAudio?.();
    driver.unlockAudio?.();
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it("沒經過手勢解鎖就 finish：不打 /api/tts（不白花額度）、回報 onSpeechFailed、不卡在說話中", () => {
    const { hooks, speaking, failed } = makeHooks();
    const driver = createMonogramDriver(hooks);
    driver.finish("這一則沒有人解鎖過");
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(speaking).toEqual([]);
    expect(FakeAudioContext.instances).toHaveLength(0); // 也不可以在手勢外硬開一個
  });

  it("🔴 AudioContext 是 suspended 而 resume() 永遠不回來：不可以卡住，直接回報、不打 /api/tts", async () => {
    FakeAudioContext.initialState = "suspended";
    FakeAudioContext.resumeWorks = false;
    const { driver, speaking, failed } = unlockedDriver();

    driver.finish("這一則放不出來");
    await drain();

    expect(fakeFetch).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(speaking).toEqual([]);
  });

  it("合成回來時 context 已經被暫停（iOS 切背景）：不呼叫 play、回報失敗、說話狀態收回", async () => {
    const { driver, speaking, failed } = unlockedDriver();
    const gate = deferred();
    responders = [gate.responder];

    driver.finish("合成途中被暫停");
    await drain();
    expect(speaking).toEqual([true]);

    ctx().state = "suspended";
    gate.release(pcm(0.5));
    await drain();

    expect(failed).toHaveBeenCalledTimes(1);
    expect(speaking).toEqual([true, false]);
    expect(ctx().scheduled).toHaveLength(0);
  });
});

describe("正常朗讀", () => {
  it("送出就回報說話中、打一次 /api/tts、音訊排進播放圖、播完才回報停止", async () => {
    const { driver, speaking, failed } = unlockedDriver();
    responders = [pcm(0.5)];

    driver.finish("  婦女新知是 1982 年 2 月創刊的。  ");
    // ⚠️ 請求在飛時就是 true：答案出來到開口之間要 1～2 秒，這段不能看起來像閒著
    expect(speaking).toEqual([true]);
    await drain();

    expect(calls.map((c) => c.text)).toEqual(["婦女新知是 1982 年 2 月創刊的。"]);
    expect(ctx().scheduled.length).toBeGreaterThan(0);

    // 串流收完了但聲音還在播：0.08 LEAD ＋ 0.5 秒音訊 ＋ 0.25 緩衝 ≈ 830ms 才算講完
    await vi.advanceTimersByTimeAsync(700);
    expect(speaking).toEqual([true]);
    await vi.advanceTimersByTimeAsync(200);
    expect(speaking).toEqual([true, false]);
    expect(failed).not.toHaveBeenCalled();
  });

  it("push() 一律忽略：要等整段答案（speakableAnswer）才開口", async () => {
    const { driver, speaking } = unlockedDriver();
    driver.push("串流中的");
    driver.push("片段。");
    await drain();
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(speaking).toEqual([]);
  });

  it("空字串不送、也不回報失敗（那會是一句沒有指涉對象的提示）", () => {
    const { driver, speaking, failed } = unlockedDriver();
    driver.finish(" \n ");
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(speaking).toEqual([]);
  });

  it("🔴 超過 600 字：切段依序合成、每段 ≤ 600、全部念完、段與段在播放圖上無縫相接", async () => {
    const { driver, speaking, failed } = unlockedDriver();
    const sentence = (i: number) => `第${String(i).padStart(2, "0")}句`.padEnd(39, "婦") + "。";
    const text = Array.from({ length: 30 }, (_, i) => sentence(i)).join(""); // 1,200 字
    responders = [pcm(1), pcm(1), pcm(1)];

    driver.finish(text);
    await drain(6000);

    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.text.length).toBeLessThanOrEqual(TTS_MAX_CHARS);
    expect(calls.map((c) => c.text).join("")).toBe(text);

    const scheduled = ctx().scheduled;
    expect(scheduled.reduce((sum, s) => sum + s.duration, 0)).toBeCloseTo(3, 5);
    for (let i = 1; i < scheduled.length; i++) {
      expect(scheduled[i].startedAt).toBeCloseTo(
        scheduled[i - 1].startedAt + scheduled[i - 1].duration,
        6
      );
    }

    await vi.advanceTimersByTimeAsync(3_400);
    expect(speaking).toEqual([true, false]);
    expect(failed).not.toHaveBeenCalled();
  });
});

describe("失敗：走 onSpeechFailed，不換聲音、不卡住", () => {
  it("503 兩次再成功：跟 heygen 同一套重試（400ms、800ms），最後照樣出聲", async () => {
    const { driver, failed } = unlockedDriver();
    responders = [status(503), status(503), pcm(0.3)];

    driver.finish("重試之後要出聲。");
    await drain();
    await vi.advanceTimersByTimeAsync(400);
    await drain();
    await vi.advanceTimersByTimeAsync(800);
    await drain();

    expect(calls).toHaveLength(3);
    expect(ctx().scheduled.length).toBeGreaterThan(0);
    expect(failed).not.toHaveBeenCalled();
  });

  it("🔴 重試用盡（502×3）：回報一次、說話狀態收回、沒有任何聲音", async () => {
    const { driver, speaking, failed } = unlockedDriver();
    responders = [status(502), status(502), status(502)];

    driver.finish("這一則合成不出來。");
    await drain();
    await vi.advanceTimersByTimeAsync(400);
    await drain();
    await vi.advanceTimersByTimeAsync(800);
    await drain();

    expect(calls).toHaveLength(3);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(speaking).toEqual([true, false]);
    expect(ctx().scheduled).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(failed).toHaveBeenCalledTimes(1); // 保險計時器不可以再報一次
  });

  it("400 不重試，直接回報", async () => {
    const { driver, failed, speaking } = unlockedDriver();
    responders = [status(400)];
    driver.finish("x");
    await drain();
    expect(calls).toHaveLength(1);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(speaking).toEqual([true, false]);
  });

  it("429 等一下再試", async () => {
    const { driver, failed } = unlockedDriver();
    responders = [status(429), pcm(0.2)];
    driver.finish("太快了。");
    await drain();
    await vi.advanceTimersByTimeAsync(400);
    await drain();
    expect(calls).toHaveLength(2);
    expect(failed).not.toHaveBeenCalled();
  });

  it("網路斷掉（fetch 丟例外）也重試，用盡才回報", async () => {
    const { driver, failed } = unlockedDriver();
    responders = [networkError(), networkError(), networkError()];
    driver.finish("斷線了。");
    await drain();
    await vi.advanceTimersByTimeAsync(400);
    await drain();
    await vi.advanceTimersByTimeAsync(800);
    await drain();
    expect(calls).toHaveLength(3);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("中間一段失敗：已經排進去的唸完，唸完才回報（不在她講話時跳提示）", async () => {
    const { driver, speaking, failed } = unlockedDriver();
    const sentence = (i: number) => `第${String(i).padStart(2, "0")}句`.padEnd(39, "婦") + "。";
    const text = Array.from({ length: 20 }, (_, i) => sentence(i)).join(""); // 800 字 → 兩段
    responders = [pcm(1), status(400)];

    driver.finish(text);
    await drain(6000);

    expect(calls).toHaveLength(2);
    expect(failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000); // 第一段還在播（0.08＋1 秒＋緩衝）
    expect(failed).not.toHaveBeenCalled();
    expect(speaking).toEqual([true]);
    await vi.advanceTimersByTimeAsync(400);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(speaking).toEqual([true, false]);
  });

  it("🔴 20 秒內一塊音訊都沒來：放棄、取消請求、回報——不可以永遠停在「回答中」", async () => {
    const { driver, speaking, failed } = unlockedDriver();
    responders = [hanging()];

    driver.finish("卡住的合成。");
    await drain();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(failed).not.toHaveBeenCalled();
    expect(speaking).toEqual([true]);

    await vi.advanceTimersByTimeAsync(2);
    await drain();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(speaking).toEqual([true, false]);
    expect(calls[0].signal?.aborted).toBe(true);
  });

  it("🔴 第二段卡住：20 秒沒有新資料就放棄那一段、請求取消，第一段唸完才回報", async () => {
    const { driver, speaking, failed } = unlockedDriver();
    responders = [pcm(1), hanging()];

    driver.finish(TWO_SEGMENTS);
    await drain(6000);
    expect(calls).toHaveLength(2);

    // 最後一塊是在 t=0 收到的；19 秒時還不算卡住
    await vi.advanceTimersByTimeAsync(19_000);
    expect(calls[1].signal?.aborted).toBe(false);
    expect(failed).not.toHaveBeenCalled();
    expect(speaking).toEqual([true]);

    await vi.advanceTimersByTimeAsync(1_000);
    await drain();
    expect(calls[1].signal?.aborted).toBe(true); // 卡住的那一段被放掉，不會再佔著
    expect(failed).not.toHaveBeenCalled(); // 已經排進去的第一段要先唸完

    // 假時鐘停在 0：第一段排在 0.08～1.08 秒，再加 0.25 秒緩衝
    await vi.advanceTimersByTimeAsync(1_400);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(speaking).toEqual([true, false]);
  });

  it("資料持續在進來就不算卡住：每 5 秒一塊、總共 30 秒才收完，看門狗每一塊都重新計時", async () => {
    const { driver, speaking, failed } = unlockedDriver();
    // 每一塊 1 秒音訊、間隔 5 秒送達（網路很慢但沒斷），6 塊
    responders = [
      async () => {
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (sent === 6) {
              controller.close();
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            sent++;
            controller.enqueue(new Uint8Array(48_000));
          },
        });
        return { ok: true, status: 200, body } as unknown as Response;
      },
    ];

    driver.finish("網路很慢的一則。");
    for (let t = 0; t < 32; t++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await drain(200);
    }
    expect(failed).not.toHaveBeenCalled();
    expect(ctx().scheduled).toHaveLength(6);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(speaking).toEqual([true, false]);
    expect(failed).not.toHaveBeenCalled();
  });

  it("串流收完之後看門狗要撤掉：一段長音訊還在唸的時候，不可以被誤判成卡住", async () => {
    const { driver, speaking, failed } = unlockedDriver();
    responders = [pcm(40, 20)]; // 40 秒的音訊，串流一下子就收完（生成比實時快）

    driver.finish("很長的一段回答。");
    await drain(6000);

    await vi.advanceTimersByTimeAsync(30_000); // 早就超過 20 秒，但她還在唸
    expect(speaking).toEqual([true]);
    await vi.advanceTimersByTimeAsync(11_000); // 0.08＋40 秒＋0.25 緩衝之後才算講完
    expect(speaking).toEqual([true, false]);
    expect(failed).not.toHaveBeenCalled();
  });

  it("合成回了 200 但一個取樣都沒有：一樣要回報，不可以無聲又零解釋", async () => {
    const { driver, failed, speaking } = unlockedDriver();
    responders = [pcm(0)];
    driver.finish("空的音訊。");
    await drain();
    await vi.advanceTimersByTimeAsync(300);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(speaking).toEqual([true, false]);
  });

  it("沒有 Web Audio 的瀏覽器：audioAvailable 是 false；硬叫 finish 也只回報失敗、不丟例外", () => {
    vi.stubGlobal("window", { fetch: fakeFetch, ReadableStream });
    const { hooks, failed } = makeHooks();
    const driver = createMonogramDriver(hooks);
    expect(driver.audioAvailable).toBe(false);
    expect(() => driver.unlockAudio?.()).not.toThrow();
    expect(() => driver.finish("x")).not.toThrow();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});

describe("打斷：關閉朗讀、送出新問題、卸載", () => {
  it("🔴 stop() 時請求還在飛：abort 掉、說話狀態收回、不算失敗，之後也不會突然開口", async () => {
    const { driver, speaking, failed } = unlockedDriver();
    responders = [hanging()];

    driver.finish("還在合成就被關掉。");
    await drain();
    driver.stop();
    await drain();

    expect(calls[0].signal?.aborted).toBe(true);
    expect(speaking).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failed).not.toHaveBeenCalled();
    expect(ctx().scheduled).toHaveLength(0);
  });

  it("stop() 時正在播：已排的聲音停掉、串流也取消", async () => {
    const { driver, speaking, failed } = unlockedDriver();
    responders = [pcm(2)];

    driver.finish("正在唸的時候被關掉。");
    await drain();
    expect(ctx().scheduled.length).toBeGreaterThan(0);

    driver.stop();
    expect(ctx().stoppedSources).toBeGreaterThan(0);
    expect(speaking).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(failed).not.toHaveBeenCalled();
    expect(speaking).toEqual([true, false]);
  });

  it("🔴 念到第二段時 stop()：第二段還在飛的合成請求也要 abort（不白吃額度與限流），不回報失敗", async () => {
    const { driver, speaking, failed } = unlockedDriver();
    responders = [pcm(1), hanging()];

    driver.finish(TWO_SEGMENTS);
    await drain(6000);
    expect(calls).toHaveLength(2);

    driver.stop();
    await drain();
    expect(calls[1].signal?.aborted).toBe(true);
    expect(speaking).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failed).not.toHaveBeenCalled();
  });

  it("舊的回應晚到（fetch 沒理會 abort）：不可以停掉新的一則，也不可以改念舊答案", async () => {
    const { driver, failed } = unlockedDriver();
    const late = lateIgnoringAbort();
    responders = [late.responder, pcm(0.5)];

    driver.finish("第一題的答案。");
    await drain();
    driver.finish("第二題的答案。");
    await drain();
    const scheduled = ctx().scheduled.length;
    const stopped = ctx().stoppedSources;
    expect(scheduled).toBeGreaterThan(0);

    late.release();
    await drain();

    expect(late.cancel).toHaveBeenCalled(); // 舊答案的串流直接丟掉
    expect(ctx().scheduled.length).toBe(scheduled); // 沒有改念舊答案
    expect(ctx().stoppedSources).toBe(stopped); // 也沒有把正在唸的新答案停掉
    expect(failed).not.toHaveBeenCalled();
  });

  it("🔴 舊一則的結束計時器在新一則已經開始之後才觸發：不可以清掉新一則的狀態，也不可以誤觸發 onSpeechFailed／onSpeakingChange(false)", async () => {
    // ⚠️ 正常時序下這個競速永遠不會發生：halt() 一定先同步 clearTimeout() 掉舊一則的
    // 計時器，才會把 current 換成新一則——這裡故意讓 halt() 那一次 clearTimeout()
    // 失效（模擬「想清但沒清掉」），才能重現「舊計時器在新一則開始後才觸發」的時序。
    // 這只在測試檔內動全域 clearTimeout，不改 monogram.ts 本身的任何一行。
    const { driver, speaking, failed } = unlockedDriver();
    responders = [pcm(0.3), pcm(1)];

    driver.finish("第一則的答案。");
    await drain();
    expect(speaking).toEqual([true]); // 第一則：串流收完，正在等結束計時器收尾（≈630ms 後）

    const realClearTimeout = globalThis.clearTimeout;
    try {
      globalThis.clearTimeout = (() => {}) as typeof globalThis.clearTimeout;
      driver.finish("第二則的答案。"); // halt() 想清掉第一則的結束計時器，但這次清不掉
    } finally {
      globalThis.clearTimeout = realClearTimeout;
    }
    expect(speaking).toEqual([true, false, true]); // halt() 收回、第二則開始
    await drain();

    // 推到第一則原本結束計時器會觸發的時間點（≈630ms）附近；第二則是 1 秒音訊，還在唸
    await vi.advanceTimersByTimeAsync(900);
    expect(speaking).toEqual([true, false, true]); // 第一則的殘留計時器不可以誤報「講完了」
    expect(failed).not.toHaveBeenCalled(); // 也不可以誤報失敗

    // 第二則自己要能正常收尾——如果 current 被第一則的殘留計時器誤清成 null，
    // 這個 false 永遠不會出現（第二則的 settle() 會被當成過期而被吞掉）。
    await vi.advanceTimersByTimeAsync(700);
    expect(speaking).toEqual([true, false, true, false]);
    expect(failed).not.toHaveBeenCalled();
  });

  it("新的一題蓋過舊的：舊的請求取消、只唸新的、舊的不回報失敗", async () => {
    const { driver, speaking, failed } = unlockedDriver();
    responders = [hanging(), pcm(0.3)];

    driver.finish("第一題的答案。");
    await drain();
    driver.finish("第二題的答案。");
    await drain();

    expect(calls[0].signal?.aborted).toBe(true);
    expect(calls[1].text).toBe("第二題的答案。");
    expect(calls[1].signal?.aborted).toBe(false);
    expect(ctx().scheduled.length).toBeGreaterThan(0);
    expect(speaking).toEqual([true, false, true]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(failed).not.toHaveBeenCalled();
    expect(speaking).toEqual([true, false, true, false]);
  });

  it("destroy()（元件卸載）：請求取消、AudioContext 關掉，之後完全靜音、可重複呼叫", async () => {
    const { driver, failed } = unlockedDriver();
    responders = [hanging()];

    driver.finish("卸載前的最後一則。");
    await drain();
    await driver.destroy();
    await driver.destroy();

    expect(calls[0].signal?.aborted).toBe(true);
    expect(ctx().closed).toBe(true);

    driver.finish("卸載之後不該出聲");
    driver.unlockAudio?.();
    driver.stop();
    await drain();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(failed).not.toHaveBeenCalled();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(driver.audioAvailable).toBe(false);
  });
});
