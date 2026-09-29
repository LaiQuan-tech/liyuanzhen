/**
 * stage-session 的單元測試：注入劇本式的假 driver（createDriver），直接驗編排本身。
 *
 * 守的東西：
 * - db896b6 的每一項修正與子項：onFatal ①～⑥、degradedRef、prepare 回來時的 isCurrentDriver、
 *   teardown 把閒置 ref 清成 null、prepare 自己接住 driver 建不起來的錯誤、沒有 driver 時明講沒聲音。
 *   （prepare「開新計時器前先收舊的」那兩行在 session 版走不到：成功段要跑第二次，只有元件版 videoReady 閉包的
 *   舊值空窗辦得到，差異 ① 把它關掉了；teardown／onFatal 都會先把 ref 清成 null。所以沒有獨立的測試。）
 * - 舊治具（假 React）抓不到的四件事：StrictMode 的 mount→unmount→mount、<video> 晚到（autoStart 輪詢）、
 *   手勢同步段（prepare 一回來、還沒 await 就已經解除靜音／unlockAudio）、同步回報（destroy 永遠不回來也已經回報）。
 * - 跟元件版的語意差異 ①（見 stage-session.ts 檔頭）。
 * 斷言優先寫行為（畫面狀態、回呼、有沒有開 session、回報了什麼）；計時器數這類機制斷言寫成 expect.soft 當第二道。
 *
 * 劇本式的假 driver（makeDriver）：要求 heygen／mock 時是計費 driver（需要 <video>，prepare 接通後才開 session、
 * 回報 onSessionLimit／onSessionOpened），其他是 monogram（不計費、有 unlockAudio）。接通、建立、destroy 的時機都由
 * script 控制；fatal() 直接呼叫它拿到的 hooks.onFatal——違約（報兩次、destroy 之後報）也做得到。
 *
 * 同一套行為用真的 driver 跑一遍的情境版在 ./stage-session.scenarios.test.ts；元件的接線在
 * components/avatar/AvatarStage.harness.test.ts。不連網：fetch 陷阱與 afterEach 斷言見 ./stage-session.fixtures.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAKE_TIMERS,
  asVideo,
  createFakeVideo,
  expectNoUnexpectedNetwork,
  flush,
  gate,
  installNetworkTraps,
  net,
  resetNet,
} from "./stage-session.fixtures";
import { createStageSession, type CreateAvatarDriver, type StageCallbacks } from "./stage-session";
import type { AvatarDriver, AvatarDriverHooks, AvatarProvider } from "./types";

// trace 收進陣列（只用 vi.hoisted 的東西，工廠在 import stage-session 時就會執行）
const hoisted = vi.hoisted(() => ({ traces: [] as string[] }));
vi.mock("@/lib/trace", () => ({
  trace: (label: string, detail?: string) => {
    hoisted.traces.push(detail ? `${label}｜${detail}` : label);
  },
  traceReset: () => {},
}));
const traces = hoisted.traces;

// ── 劇本式的假 driver ────────────────────────────────────────────
interface ScriptedDriver extends AvatarDriver {
  readonly id: number;
  readonly requested: AvatarProvider | undefined;
  readonly hooks: AvatarDriverHooks;
  /** 被呼叫過的方法，依序（push／finish 帶內容） */
  readonly calls: string[];
  /** 每次 prepare 收到的 <video> */
  readonly videos: Array<HTMLVideoElement | null>;
  /** 計費 driver 真的開了幾個 session */
  sessionsOpened: number;
  destroyed: boolean;
  /** 直接呼叫它拿到的 hooks.onFatal（違約也可以） */
  fatal(message?: string): void;
}

const script = {
  created: [] as ScriptedDriver[],
  /** 每一次 createDriver 被要求的 provider（undefined ＝ 頁面沒指定） */
  requests: [] as Array<AvatarProvider | undefined>,
  /** 依序消耗：這一次建立成功還是失敗（空的就是成功） */
  createPlan: [] as Array<"ok" | "fail">,
  /** 計費 driver 的 prepare 卡在這裡（接通中） */
  meteredPrepareGate: null as Promise<void> | null,
  /** monogram 的 prepare 卡在這裡 */
  monogramPrepareGate: null as Promise<void> | null,
  /** 計費 driver 接通時直接報 fatal、不開 session（像 token 被拒） */
  prepareFatal: false,
  /** destroy() 回傳永遠不 resolve 的 promise */
  destroyNever: false,
  /** 接通時回報的 max_session_duration（秒）；null ＝ 伺服器沒給 */
  sessionLimit: 180 as number | null,
  /** monogram 在這個瀏覽器放不放得出聲音 */
  monogramAudioAvailable: true,
};

function resetScript(): void {
  script.created = [];
  script.requests = [];
  script.createPlan = [];
  script.meteredPrepareGate = null;
  script.monogramPrepareGate = null;
  script.prepareFatal = false;
  script.destroyNever = false;
  script.sessionLimit = 180;
  script.monogramAudioAvailable = true;
}

function makeDriver(hooks: AvatarDriverHooks, requested: AvatarProvider | undefined): ScriptedDriver {
  const metered = requested === "heygen" || requested === "mock";
  const id = script.created.length + 1;
  let prepared = false;
  let preparing = false;
  const driver: ScriptedDriver = {
    id,
    requested,
    hooks,
    calls: [],
    videos: [],
    sessionsOpened: 0,
    destroyed: false,
    provider: metered && requested ? requested : "monogram",
    needsVideo: metered,
    metered,
    get audioAvailable() {
      return metered ? prepared : script.monogramAudioAvailable;
    },
    async prepare(video) {
      driver.calls.push("prepare");
      driver.videos.push(video);
      if (!metered) {
        if (script.monogramPrepareGate) await script.monogramPrepareGate;
        return;
      }
      if (prepared || preparing || driver.destroyed) return;
      preparing = true;
      try {
        if (script.meteredPrepareGate) await script.meteredPrepareGate;
        // 跟 heygen 一樣：destroy 之後才回來就不開 session、也不報 fatal
        if (driver.destroyed) return;
        if (script.prepareFatal) {
          hooks.onFatal(new Error("劇本：token 被拒"));
          return;
        }
        if (script.sessionLimit !== null) hooks.onSessionLimit?.(script.sessionLimit);
        hooks.onSessionOpened?.(`sid-${id}`);
        driver.sessionsOpened += 1;
        prepared = true;
      } finally {
        preparing = false;
      }
    },
    unlockAudio: metered
      ? undefined
      : () => {
          driver.calls.push("unlockAudio");
        },
    push(delta) {
      driver.calls.push(`push:${delta}`);
    },
    finish(fullText) {
      driver.calls.push(`finish:${fullText}`);
    },
    stop() {
      driver.calls.push("stop");
    },
    destroy() {
      driver.calls.push("destroy");
      driver.destroyed = true;
      return script.destroyNever ? new Promise<void>(() => {}) : Promise.resolve();
    },
    fatal(message = "劇本：斷線") {
      hooks.onFatal(new Error(message));
    },
  };
  return driver;
}

const createDriver: CreateAvatarDriver = async (hooks, provider) => {
  script.requests.push(provider);
  const outcome = script.createPlan.shift() ?? "ok";
  // 真的 createAvatarDriver 至少要等一次 dynamic import；這裡至少讓出一個 microtask
  await Promise.resolve();
  if (outcome === "fail") throw new Error("劇本：driver 模組載不到");
  const driver = makeDriver(hooks, provider);
  script.created.push(driver);
  return driver;
};

function driverAt(n: number): ScriptedDriver {
  const driver = script.created[n - 1];
  if (!driver) throw new Error(`第 ${n} 個 driver 還沒建出來（目前 ${script.created.length} 個）`);
  return driver;
}

// ── 一個 session ＋ 它的「元件」────────────────────────────────────
function setup(options: { provider?: AvatarProvider | "none"; video?: boolean } = {}) {
  const video = createFakeVideo();
  let hasVideo = options.video ?? true;
  const ui = { videoReady: [] as boolean[], provider: [] as AvatarProvider[] };
  const calls = {
    speaking: [] as boolean[],
    audioAvailable: [] as boolean[],
    teardown: 0,
    speechFailed: 0,
  };
  const callbacks: StageCallbacks = {
    onSpeakingChange: (speaking) => {
      calls.speaking.push(speaking);
    },
    onAudioAvailableChange: (available) => {
      calls.audioAvailable.push(available);
    },
    onTeardown: () => {
      calls.teardown += 1;
    },
    onSpeechFailed: () => {
      calls.speechFailed += 1;
    },
  };
  const session = createStageSession({
    providerOverride: options.provider === "none" ? undefined : (options.provider ?? "heygen"),
    callbacks,
    ui: {
      setVideoReady: (ready) => {
        ui.videoReady.push(ready);
      },
      setProvider: (provider) => {
        ui.provider.push(provider);
      },
    },
    getVideo: () => (hasVideo ? asVideo(video) : null),
    createDriver,
  });
  return {
    session,
    video,
    ui,
    calls,
    /** VideoAvatar 掛上了（next/dynamic 的 chunk 載完） */
    showVideo: () => {
      hasVideo = true;
    },
  };
}
type Setup = ReturnType<typeof setup>;

/** 掛載＋一次 prepare（不是手勢），等到接通。回傳那個計費 driver */
async function connect(s: Setup): Promise<ScriptedDriver> {
  s.session.mount();
  await flush();
  void s.session.prepare();
  await flush();
  const driver = driverAt(1);
  expect(driver.sessionsOpened).toBe(1);
  return driver;
}

const TEARDOWN_TRACE = "畫面切回靜態照片";
const closeBody = (sessionId: string) => JSON.stringify({ sessionId });

beforeEach(() => {
  resetScript();
  resetNet();
  traces.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: FAKE_TIMERS });
  installNetworkTraps();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expectNoUnexpectedNetwork();
});

describe("建構", () => {
  it("createStageSession 是純的：不建 driver、不開計時器、不回報、不動畫面", () => {
    const s = setup();
    expect(script.requests).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(net.closeCalls).toBe(0);
    expect(s.ui).toEqual({ videoReady: [], provider: [] });
  });
});

describe("StrictMode：mount→unmount→mount", () => {
  it("只呼叫一次 createDriver，建好的 driver 沒有被 destroy", async () => {
    const s = setup();
    s.session.mount();
    s.session.unmount();
    s.session.mount();
    await flush();
    expect(script.requests).toEqual(["heygen"]);
    expect(driverAt(1).destroyed).toBe(false);
    expect(s.ui.provider).toEqual(["heygen"]);
  });

  it("連 autoStart 一起重播：計費 driver 只 prepare 一次、只開一個 session", async () => {
    const s = setup();
    // 元件的 effect 依序跑；StrictMode 先整批 cleanup 再整批重跑
    s.session.mount();
    let cancel = s.session.autoStart();
    s.session.unmount();
    cancel();
    s.session.mount();
    cancel = s.session.autoStart();
    await flush(200);
    expect(script.requests).toEqual(["heygen"]);
    const driver = driverAt(1);
    expect(driver.calls.filter((c) => c === "prepare")).toHaveLength(1);
    expect(driver.sessionsOpened).toBe(1);
    expect(s.ui.videoReady.at(-1)).toBe(true);
  });
});

describe("<video> 晚到（autoStart 輪詢）", () => {
  it("等到 getVideo 有值才 prepare（每 100 毫秒看一次），接上的是那個 <video>", async () => {
    const s = setup({ video: false });
    s.session.mount();
    s.session.autoStart();
    await flush(350);
    const driver = driverAt(1);
    expect(driver.calls).not.toContain("prepare");
    s.showVideo();
    await flush(100);
    expect(driver.calls.filter((c) => c === "prepare")).toHaveLength(1);
    expect(driver.videos).toEqual([asVideo(s.video)]);
    expect(driver.sessionsOpened).toBe(1);
  });

  it("4 秒內等不到就放棄並留痕：不 prepare、不開計費；之後 <video> 出現也不會自己接", async () => {
    const s = setup({ video: false });
    s.session.mount();
    s.session.autoStart();
    await flush(4_100);
    expect(traces).toContain("自動連線放棄：4 秒內等不到 <video>");
    s.showVideo();
    await flush(10_000);
    const driver = driverAt(1);
    expect(driver.calls).not.toContain("prepare");
    expect(driver.sessionsOpened).toBe(0);
  });

  it("沒有 <video> 時按說話：不呼叫 driver.prepare、不開計費 session，而且要吵（console.error）", async () => {
    const s = setup({ video: false });
    s.session.mount();
    await flush();
    void s.session.prepare({ unmute: true });
    await flush();
    const driver = driverAt(1);
    expect(driver.calls).not.toContain("prepare");
    expect(driver.sessionsOpened).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("driver 需要 <video> 但 videoRef 是空的"));
  });

  it("autoStart 的取消函式：取消之後 <video> 才出現，就不接", async () => {
    const s = setup({ video: false });
    s.session.mount();
    const cancel = s.session.autoStart();
    await flush(150);
    cancel();
    s.showVideo();
    await flush(1_000);
    expect(driverAt(1).calls).not.toContain("prepare");
  });

  it("一個 mount 只自動連一次：接過之後再呼叫 autoStart（effect 重跑）、或 teardown 之後，都不會自己重連", async () => {
    const s = setup();
    s.session.mount();
    s.session.autoStart();
    await flush(200);
    expect(driverAt(1).sessionsOpened).toBe(1);
    await s.session.teardown("閒置逾時");
    s.session.autoStart();
    await flush(1_000);
    expect(script.requests).toEqual(["heygen"]);
  });
});

describe("手勢同步段：prepare 一回來（還沒 await）就要做完", () => {
  it("prepare({ unmute: true })：當下就解除靜音、play()", async () => {
    const s = setup();
    s.session.mount();
    await flush();
    expect(s.video.muted).toBe(true);
    const p = s.session.prepare({ unmute: true });
    expect(s.video.muted).toBe(false);
    expect(s.video.plays).toBe(1);
    await p;
  });

  it("monogram：prepare({ unmute: true }) 當下就 unlockAudio（AudioContext 只能在手勢裡開）", async () => {
    const s = setup({ provider: "monogram" });
    s.session.mount();
    await flush();
    const mono = driverAt(1);
    expect(mono.calls).toEqual(["prepare"]); // 掛載時 prepare(null)，只問 audioAvailable
    const p = s.session.prepare({ unmute: true });
    expect(mono.calls.slice(0, 2)).toEqual(["prepare", "unlockAudio"]);
    await p;
  });

  it("前一次 prepare 還在飛（autoStart 接通中）：這一下照樣當下解除靜音，而且不另開一個", async () => {
    const connecting = gate();
    script.meteredPrepareGate = connecting.promise;
    const s = setup();
    s.session.mount();
    s.session.autoStart();
    await flush();
    const driver = driverAt(1);
    expect(driver.calls).toEqual(["prepare"]);
    const p = s.session.prepare({ unmute: true });
    expect(s.video.muted).toBe(false);
    expect(s.video.plays).toBe(1);
    expect(driver.calls).toEqual(["prepare"]);
    connecting.release();
    await p;
    await flush();
    expect(driver.sessionsOpened).toBe(1);
    expect(s.video.muted).toBe(false); // 接通後照「按過了」蓋回去
  });

  it("monogram：前一次 prepare 還在飛，這一下照樣當下 unlockAudio", async () => {
    const s = setup({ provider: "monogram" });
    s.session.mount();
    await flush();
    const mono = driverAt(1);
    const hold = gate();
    script.monogramPrepareGate = hold.promise;
    void s.session.prepare(); // 「開啟朗讀」那一下，還在飛
    const p = s.session.prepare({ unmute: true }); // 送出問題的那一下
    expect(mono.calls.filter((c) => c === "unlockAudio")).toHaveLength(1);
    hold.release();
    await p;
  });

  it("沒帶 unmute（autoStart）：不解除靜音、不 unlockAudio；接通之後照舊靜音", async () => {
    const s = setup();
    s.session.mount();
    s.session.autoStart();
    await flush(200);
    expect(driverAt(1).sessionsOpened).toBe(1);
    expect(s.video.muted).toBe(true);
    expect(s.video.plays).toBe(1); // 只有接通之後蓋回靜音那一次 play
  });
});

describe("同步回報 session 結束（在任何 await 之前）", () => {
  it("teardown：destroy 永遠不回來，回報也已經送出；onTeardown 要等 destroy 之後", async () => {
    script.destroyNever = true;
    const s = setup();
    await connect(s);
    const done = s.session.teardown("離開頁面");
    expect(net.closeCalls).toBe(1);
    expect(net.closeVia).toEqual(["beacon"]);
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    await flush(1_000);
    expect(net.closeBodies).toEqual([closeBody("sid-1")]);
    expect(settled).toBe(false);
    expect(s.calls.teardown).toBe(0);
  });

  it("onFatal：destroy 永遠不回來，onFatal 回來之前就已經回報；報過就清掉，不會重報", async () => {
    script.destroyNever = true;
    const s = setup();
    const heygen = await connect(s);
    heygen.fatal();
    expect(net.closeCalls).toBe(1);
    await flush();
    expect(net.closeBodies).toEqual([closeBody("sid-1")]);
    void s.session.teardown("切到背景分頁"); // 不 await：destroy 永遠不回來
    await flush();
    expect(net.closeCalls).toBe(1);
  });

  it("token 被拒（沒有 session id）：onFatal 不回報", async () => {
    script.prepareFatal = true;
    const s = setup();
    s.session.mount();
    await flush();
    void s.session.prepare({ unmute: true });
    await flush();
    expect(s.ui.provider.at(-1)).toBe("monogram");
    expect(net.closeCalls).toBe(0);
  });

  it("sendBeacon 被拒：退到 fetch keepalive，一樣當下送出", async () => {
    net.beaconRefuses = true;
    const s = setup();
    await connect(s);
    void s.session.teardown("切到背景分頁");
    expect(net.closeCalls).toBe(1);
    expect(net.closeVia).toEqual(["fetch"]);
    expect(net.closeBodies).toEqual([closeBody("sid-1")]);
  });
});

describe("onFatal ①：過期的、destroy 之後的、卸載之後的回報都不理", () => {
  it("monogram 接手（而且解鎖了）之後，舊 driver 又報一次：不收掉 monogram、不重建、不重報；答案照常交給它", async () => {
    const s = setup();
    const heygen = await connect(s);
    heygen.fatal("第一次");
    await flush();
    const mono = driverAt(2);
    void s.session.prepare({ unmute: true });
    await flush();
    const before = { requests: script.requests.length, provider: s.ui.provider.length, closes: net.closeCalls };
    heygen.fatal("遲到的第二次");
    await flush();
    s.session.finish("這一題的答案。");
    expect(mono.calls).toContain("finish:這一題的答案。");
    expect(mono.destroyed).toBe(false);
    expect(script.requests).toHaveLength(before.requests);
    expect(s.ui.provider).toHaveLength(before.provider);
    expect(net.closeCalls).toBe(before.closes);
  });

  it("切分頁收掉之後才報：不降級；下一次按說話照舊重建 heygen", async () => {
    const s = setup();
    const heygen = await connect(s);
    await s.session.teardown("切到背景分頁");
    heygen.fatal("destroy 之後才報");
    await flush();
    expect(s.ui.provider).toEqual(["heygen"]);
    expect(script.requests).toEqual(["heygen"]);
    void s.session.prepare({ unmute: true });
    await flush();
    expect(script.requests).toEqual(["heygen", "heygen"]);
    expect(driverAt(2).sessionsOpened).toBe(1);
  });

  it("卸載之後才報：不降級、不建 driver", async () => {
    const s = setup();
    const heygen = await connect(s);
    s.session.unmount();
    heygen.fatal("卸載之後");
    await flush();
    expect(s.ui.provider).toEqual(["heygen"]);
    expect(script.requests).toEqual(["heygen"]);
  });
});

describe("onFatal ②：閒置與上限計時器停掉、閒置 ref 清成 null", () => {
  it("降級之後不管多久、有沒有活動，都不會再跑收線", async () => {
    const s = setup();
    const heygen = await connect(s);
    s.session.reportActivity();
    heygen.fatal();
    await flush();
    // 機制（第二道，soft）
    expect.soft(vi.getTimerCount(), "降級之後還有待觸發的計時器").toBe(0);
    const uiMark = s.ui.videoReady.length;
    const traceMark = traces.length;
    for (let i = 0; i < 4; i++) {
      s.session.reportActivity();
      await flush(50_000);
    }
    await flush(100_000);
    // 行為：收線在 monogram 上看得到的後果——畫面狀態被再寫一次、debug 面板多一筆「畫面切回靜態照片」
    expect(s.ui.videoReady.slice(uiMark)).toEqual([]);
    expect(traces.slice(traceMark).filter((t) => t.startsWith(TEARDOWN_TRACE))).toEqual([]);
  });
});

describe("onFatal ④：收掉失效的 driver", () => {
  it("destroy 它、影像標成沒就緒；卡在半路的 prepare 不會擋住下一次按說話", async () => {
    const connecting = gate();
    script.meteredPrepareGate = connecting.promise;
    const s = setup();
    s.session.mount();
    s.session.autoStart();
    await flush();
    const heygen = driverAt(1);
    heygen.fatal("接通途中斷線");
    expect(heygen.destroyed).toBe(true);
    expect(s.ui.videoReady).toEqual([false]);
    await flush();
    const mono = driverAt(2);
    void s.session.prepare({ unmute: true });
    await flush();
    // 建立時一次 prepare(null)、這一下一次——沒有被那個卡住的舊 prepare 吃掉
    expect(mono.calls.filter((c) => c === "prepare")).toHaveLength(2);
    expect(s.calls.audioAvailable.at(-1)).toBe(true);
    connecting.release();
    await flush();
  });
});

describe("onFatal ⑤：這個 mount 之後一律 monogram", () => {
  it("畫面當下換成「李」字（不等 monogram 建好），並留一筆說明", async () => {
    const s = setup();
    const heygen = await connect(s);
    heygen.fatal("斷線");
    expect(s.ui.provider.at(-1)).toBe("monogram");
    expect(script.created).toHaveLength(1);
    expect(traces.at(-1)).toBe("影像接不上，改用「李」字＋老師的聲音（重新整理頁面才會再試影像）｜斷線");
  });
});

describe("onFatal ⑥：立刻把 monogram 建好", () => {
  it("onFatal 當下就開始建；建好只問 audioAvailable、不解鎖；下一次按說話才在手勢裡解鎖", async () => {
    const s = setup();
    const heygen = await connect(s);
    heygen.fatal();
    expect(script.requests).toEqual(["heygen", "monogram"]);
    await flush();
    const mono = driverAt(2);
    expect(mono.calls).toEqual(["prepare"]);
    expect(mono.videos).toEqual([null]);
    expect(s.calls.audioAvailable.at(-1)).toBe(true);
    const p = s.session.prepare({ unmute: true });
    expect(mono.calls.slice(0, 2)).toEqual(["prepare", "unlockAudio"]);
    await p;
  });

  it("monogram 建不起來：只記錄、不丟未處理的 rejection；這時的答案明講沒聲音；下一次按說話再試（仍然是 monogram）", async () => {
    const s = setup();
    const heygen = await connect(s);
    script.createPlan = ["fail"];
    heygen.fatal();
    await flush();
    expect(console.error).toHaveBeenCalledWith("[avatar] 降級用的 monogram 建不起來：", expect.any(Error));
    s.session.finish("這一題的答案。");
    expect(s.calls.speechFailed).toBe(1);
    expect(traces).toContain("答案沒有 driver 可送，這一段不會有聲音｜7 字");
    void s.session.prepare({ unmute: true });
    await flush();
    expect(script.requests).toEqual(["heygen", "monogram", "monogram"]);
    expect(driverAt(2).provider).toBe("monogram");
  });

  it("按說話時還是建不起來：prepare 自己接住（不丟 unhandled rejection），答案明講沒聲音", async () => {
    const s = setup();
    const heygen = await connect(s);
    script.createPlan = ["fail", "fail"];
    heygen.fatal();
    await flush();
    void s.session.prepare({ unmute: true });
    await flush();
    expect(console.error).toHaveBeenCalledWith("[avatar] driver 建不起來：", expect.any(Error));
    s.session.finish("答案");
    expect(s.calls.speechFailed).toBe(1);
  });
});

describe("degradedRef：降級是這個 mount 的事，不會回頭建 heygen", () => {
  it("降級過的 session 重新 mount（StrictMode 重播）也只建 monogram", async () => {
    const s = setup();
    const heygen = await connect(s);
    heygen.fatal();
    await flush();
    s.session.unmount();
    s.session.mount();
    await flush();
    expect(script.requests).toEqual(["heygen", "monogram", "monogram"]);
    expect(s.ui.provider.at(-1)).toBe("monogram");
  });

  it("沒降級：teardown 之後下一次按說話照頁面指定的重建 heygen、重開 session", async () => {
    const s = setup();
    await connect(s);
    await s.session.teardown("切到背景分頁");
    void s.session.prepare({ unmute: true });
    await flush();
    expect(script.requests).toEqual(["heygen", "heygen"]);
    expect(driverAt(2).sessionsOpened).toBe(1);
    expect(s.ui.videoReady.at(-1)).toBe(true);
  });
});

describe("prepare 回來時 driver 已經被換掉（isCurrentDriver）：什麼都不碰", () => {
  it("接通途中被 teardown：不標影像就緒、不開計時器；之後重接正常，也不會被舊的計時器收掉", async () => {
    const connecting = gate();
    script.meteredPrepareGate = connecting.promise;
    const s = setup();
    s.session.mount();
    s.session.autoStart();
    await flush();
    await s.session.teardown("切到背景分頁");
    connecting.release();
    await flush();
    expect(s.ui.videoReady).not.toContain(true);
    expect(traces).toContain("接通回來時這個 driver 已經被換掉，不動畫面");
    expect.soft(vi.getTimerCount(), "被收掉的接通留下了計時器").toBe(0);

    script.meteredPrepareGate = null;
    await flush(10_000);
    void s.session.prepare({ unmute: true }); // +10 秒重接
    await flush();
    expect(driverAt(2).sessionsOpened).toBe(1);
    expect(s.ui.videoReady.at(-1)).toBe(true);
    await flush(70_000); // +80 秒：舊的接通要是開了計時器，這裡會把新的收掉
    expect(s.calls.teardown).toBe(1);
  });

  it("接通途中 driver 報 fatal：回來之後不標影像就緒、不開計時器", async () => {
    const connecting = gate();
    script.meteredPrepareGate = connecting.promise;
    const s = setup();
    s.session.mount();
    s.session.autoStart();
    await flush();
    driverAt(1).fatal("接通途中斷線");
    connecting.release();
    await flush();
    expect(s.ui.videoReady).not.toContain(true);
    expect(s.ui.provider.at(-1)).toBe("monogram");
    expect.soft(vi.getTimerCount(), "被收掉的接通留下了計時器").toBe(0);
  });

  it("接通途中卸載：回來之後不標影像就緒、不開計時器", async () => {
    const connecting = gate();
    script.meteredPrepareGate = connecting.promise;
    const s = setup();
    s.session.mount();
    s.session.autoStart();
    await flush();
    s.session.unmount();
    connecting.release();
    await flush();
    expect(s.ui.videoReady).not.toContain(true);
    expect.soft(vi.getTimerCount(), "被收掉的接通留下了計時器").toBe(0);
  });
});

describe("teardown", () => {
  it("停掉的閒置計時器要清成 null：之後的活動不會把它叫回來，重接途中不會被它收掉", async () => {
    const s = setup();
    await connect(s);
    await s.session.teardown("切到背景分頁");
    expect(s.calls.teardown).toBe(1);
    // 機制（第二道，soft）
    const timers = vi.getTimerCount();
    s.session.reportActivity();
    expect.soft(vi.getTimerCount(), "teardown 之後 reportActivity 叫回了計時器").toBe(timers);

    // 行為：有過活動，72 秒後才重接（不先 reportActivity），接通要 5 秒
    s.session.finish("答案");
    await flush(72_000);
    const connecting = gate();
    script.meteredPrepareGate = connecting.promise;
    void s.session.prepare();
    await flush(5_000); // 距離上一次活動 +77 秒：還在接
    expect(s.calls.teardown).toBe(1);
    connecting.release();
    await flush();
    expect(driverAt(2).sessionsOpened).toBe(1);
    expect(s.ui.videoReady.at(-1)).toBe(true);
  });

  it("沒有計費中的 session（monogram）：只把畫面標成沒就緒並留痕，不 destroy、不通知 onTeardown", async () => {
    const s = setup({ provider: "monogram" });
    s.session.mount();
    await flush();
    await s.session.teardown("閒置逾時");
    expect(driverAt(1).destroyed).toBe(false);
    expect(s.calls.teardown).toBe(0);
    expect(s.ui.videoReady).toEqual([false]);
    expect(traces).toContain(`${TEARDOWN_TRACE}｜閒置逾時（沒有計費中的 session 要收）`);
  });

  it("計費中：當下 destroy；destroy 完才收說話狀態、通知 onTeardown", async () => {
    const s = setup();
    const heygen = await connect(s);
    const done = s.session.teardown("切到背景分頁");
    expect(heygen.destroyed).toBe(true);
    expect(s.calls.teardown).toBe(0);
    await done;
    expect(s.calls.speaking.at(-1)).toBe(false);
    expect(s.calls.teardown).toBe(1);
    expect(traces).toContain("串流被收掉｜切到背景分頁");
  });
});

describe("閒置與上限計時器", () => {
  it("閒置 75 秒（從最後一次活動算）就收掉；push、finish、reportActivity 都算活動", async () => {
    script.sessionLimit = 3600;
    const s = setup();
    await connect(s);
    await flush(70_000);
    s.session.push("…");
    await flush(70_000);
    s.session.finish("答案");
    await flush(70_000);
    s.session.reportActivity();
    await flush(74_000);
    expect(s.calls.teardown).toBe(0);
    await flush(2_000);
    expect(s.calls.teardown).toBe(1);
    expect(traces).toContain("串流被收掉｜閒置逾時");
  });

  it("上限照伺服器說的提早 2 秒收（180 秒 → 178 秒），有活動也照收", async () => {
    const s = setup();
    await connect(s);
    for (let i = 0; i < 2; i++) {
      await flush(60_000);
      s.session.reportActivity();
    }
    await flush(57_000); // 177 秒
    expect(s.calls.teardown).toBe(0);
    await flush(2_000);
    expect(s.calls.teardown).toBe(1);
    expect(traces).toContain("串流被收掉｜撞到單次時間上限");
  });

  it("上限最少 5 秒；伺服器沒給就用 5 分鐘保底", async () => {
    script.sessionLimit = 3;
    const short = setup();
    await connect(short);
    await flush(4_900);
    expect(short.calls.teardown).toBe(0);
    await flush(200);
    expect(short.calls.teardown).toBe(1);

    resetScript();
    script.sessionLimit = null;
    const fallback = setup();
    await connect(fallback);
    for (let i = 0; i < 4; i++) {
      await flush(60_000);
      fallback.session.reportActivity();
    }
    await flush(59_000); // 299 秒
    expect(fallback.calls.teardown).toBe(0);
    await flush(2_000);
    expect(fallback.calls.teardown).toBe(1);
  });
});

describe("handle 的其他方法", () => {
  it("沒有 driver 時的答案：明講沒聲音（trace＋onSpeechFailed），不可以靜靜丟掉", () => {
    const s = setup();
    s.session.finish("答案");
    expect(s.calls.speechFailed).toBe(1);
    expect(traces).toContain("答案沒有 driver 可送，這一段不會有聲音｜2 字");
  });

  it("有 driver 時照原樣轉給它", async () => {
    const s = setup({ provider: "monogram" });
    s.session.mount();
    await flush();
    const mono = driverAt(1);
    s.session.push("半");
    s.session.finish("整段");
    s.session.stop();
    s.session.unlockAudio();
    expect(mono.calls.slice(1)).toEqual(["push:半", "finish:整段", "stop", "unlockAudio"]);
    expect(s.calls.speechFailed).toBe(0);
  });

  it("朗讀可用性：計費 driver 一建好就回報 true；monogram 問過 prepare(null) 才回報（這個瀏覽器放不出來就是 false）", async () => {
    const metered = setup();
    metered.session.mount();
    await flush();
    expect(metered.calls.audioAvailable).toEqual([true]);

    script.monogramAudioAvailable = false;
    const mono = setup({ provider: "none" });
    mono.session.mount();
    await flush();
    expect(mono.calls.audioAvailable).toEqual([false]);
  });
});

describe("跟元件版的差異 ①：「已經備好了」讀 session 自己的狀態", () => {
  it("接通之後再呼叫 prepare：不再開一個、不重排計時器（閒置照原本的時間到點）", async () => {
    script.sessionLimit = 3600;
    const s = setup();
    const heygen = await connect(s); // 閒置在 +75 秒
    await flush(40_000);
    void s.session.prepare(); // 不是手勢、沒有活動
    await flush(36_000); // +76 秒
    expect(heygen.calls.filter((c) => c === "prepare")).toHaveLength(1);
    expect(s.ui.videoReady.filter((ready) => ready)).toHaveLength(1);
    expect(s.calls.teardown).toBe(1);
  });
});
