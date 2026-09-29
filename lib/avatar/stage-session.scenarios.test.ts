/**
 * stage-session 的情境測試：舊治具（components/avatar/AvatarStage.harness.test.ts 在新增 lib/avatar/stage-session.ts 那個 commit 為止的完整版）的
 * S1–S15 原樣移植，拿掉假 React 那一層，直接驅動 createStageSession。
 *
 * 跑的是真的程式碼：stage-session、lib/avatar（index、fallback、heygen、monogram、mock、lipsync-player、
 * tts-request、speech-*）、lib/idle-timer。換成假的只有邊界（見 ./stage-session.fixtures.ts）：LiveAvatar SDK
 * （FakeSession）、fetch（fakeFetch）、Web Audio（FakeAudioContext）、sendBeacon、lib/trace（收進 traces）。
 * heygen driver 是真的，只外包一層記下它拿到的 hooks（heygenHooks），S13、S14 用它扮演違約的 driver。
 *
 * 元件那一層在這裡用最小的方式代替（見 mount()）：
 * - ui.setVideoReady／setProvider 改的 state 要等「下一次重繪」才反映到畫面與 <video>，用 microtask 模擬
 *   （跟舊治具的假 React 同一個時序；真的 React 更晚，是下一個巨任務）。
 * - <video> 在「重繪後的 provider 需要影像」時才有；VideoAvatar 晚到（next/dynamic）不在這裡，見 stage-session.test.ts。
 * - hide()／leavePage() 照元件的監聽器行為：只在需要影像時才轉成 teardown("切到背景分頁"／"離開頁面")。
 * 元件本身有沒有照這樣接線，由 components/avatar/AvatarStage.harness.test.ts（接線測試）守。
 *
 * 不連網：fakeFetch 只認三個路徑，其他記錄並 throw，afterEach 斷言沒有任何預期外的連網（見 fixtures 檔頭）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAKE_TIMERS,
  FakeAudioContext,
  asVideo,
  createFakeVideo,
  expectNoUnexpectedNetwork,
  fakeFetch,
  fakeSdkModule,
  flush,
  gate,
  heygenHooks,
  installNetworkTraps,
  net,
  recordTrace,
  resetAudio,
  resetNet,
  resetSdk,
  sdk,
  traces,
} from "./stage-session.fixtures";
import type { StageCallbacks, StageSession } from "./stage-session";
import type { AvatarDriverHooks, AvatarProvider } from "./types";

// vi.mock 會被提到檔案最上面；工廠要等 mount() 裡第一次 import 那個模組才執行，那時 fixtures 早就載入完了。
vi.mock("@/lib/trace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trace")>()),
  trace: recordTrace,
}));
vi.mock("@heygen/liveavatar-web-sdk", () => fakeSdkModule);
vi.mock("@/lib/avatar/heygen", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/avatar/heygen")>();
  return {
    ...real,
    createHeygenDriver: (hooks: AvatarDriverHooks) => {
      heygenHooks.push(hooks);
      return real.createHeygenDriver(hooks);
    },
  };
});

interface PageProps {
  provider?: AvatarProvider;
  autoStart?: boolean;
}

async function mount(props: PageProps) {
  // 先把 driver 模組載好：dynamic import 要真的事件迴圈才會完成，假時鐘推不動
  await import("@/lib/avatar/heygen");
  await import("@/lib/avatar/monogram");
  await import("@/lib/avatar/mock");
  await import("@heygen/liveavatar-web-sdk");
  const { resolveProvider } = await import("@/lib/avatar");
  const { createStageSession } = await import("@/lib/avatar/stage-session");

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

  // 元件的兩個 state（初值跟元件一樣：providerOverride ?? resolveProvider()）與「重繪後」看到的值
  const state = { provider: props.provider ?? resolveProvider(), videoReady: false };
  const rendered = { ...state };
  let renderPending = false;
  const scheduleRender = () => {
    if (renderPending) return;
    renderPending = true;
    queueMicrotask(() => {
      renderPending = false;
      rendered.provider = state.provider;
      rendered.videoReady = state.videoReady;
    });
  };
  const needsVideo = () => rendered.provider !== "monogram";
  const video = createFakeVideo();

  const session = createStageSession({
    providerOverride: props.provider,
    callbacks,
    ui: {
      setVideoReady: (ready) => {
        state.videoReady = ready;
        scheduleRender();
      },
      setProvider: (provider) => {
        state.provider = provider;
        scheduleRender();
      },
    },
    getVideo: () => (needsVideo() ? asVideo(video) : null),
  });

  // 元件的 effect，依宣告順序：掛載 → （visibility 監聽）→ 自動連線
  session.mount();
  const cancelAutoStart = props.autoStart ? session.autoStart() : () => {};

  return {
    stage: (): StageSession => session,
    calls,
    view: () => ({
      /** VideoAvatar 在畫面上（provider 需要影像） */
      video: needsVideo(),
      /** 影像就緒、淡入 */
      videoVisible: needsVideo() && rendered.videoReady,
      /** 「李」字（語音頁有 poster 時，只有不需要影像才出現） */
      monogram: !needsVideo(),
    }),
    hide: () => {
      if (needsVideo()) void session.teardown("切到背景分頁");
    },
    leavePage: () => {
      if (needsVideo()) void session.teardown("離開頁面");
    },
    unmount: () => {
      session.unmount();
      cancelAutoStart();
    },
  };
}

/** LiveStage.press 的同步段：reportActivity → prepare({ unmute: true })，中間沒有 await */
function press(stage: StageSession): void {
  stage.reportActivity();
  void stage.prepare({ unmute: true });
}

const LIVE: PageProps = { provider: "heygen", autoStart: true };
const TEARDOWN_TRACE = "畫面切回靜態照片";

beforeEach(() => {
  vi.resetModules();
  resetNet();
  resetSdk();
  resetAudio();
  traces.length = 0;
  heygenHooks.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: FAKE_TIMERS });
  vi.stubEnv("NEXT_PUBLIC_AVATAR_PROVIDER", undefined);
  installNetworkTraps();
  vi.stubGlobal("window", {
    AudioContext: FakeAudioContext,
    fetch: fakeFetch,
    ReadableStream,
    location: { search: "" },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  expectNoUnexpectedNetwork();
});

describe("stage-session 情境（真的 driver＋假 SDK／假網路，沒有 React）", () => {
  it("S1 autoStart 時 token 被拒：換「李」字；按說話之後答案由 monogram 出聲；之後不再要 token", async () => {
    net.token = [503];
    const { stage, calls, view, hide } = await mount(LIVE);
    await flush(200);
    expect(net.tokenRequests).toBe(1);
    expect(view()).toMatchObject({ video: false, monogram: true });
    expect(calls.speechFailed).toBe(0);
    expect(net.closeCalls).toBe(0); // token 被拒就沒有 session id，沒有東西要回報

    // 降級之後、按說話之前到的答案：放不出聲音（沒有手勢解鎖），要明講，也不白打 /api/tts
    stage().finish("按之前的答案。");
    await flush();
    expect(calls.speechFailed).toBe(1);
    expect(net.tts).toEqual([]);

    for (let round = 0; round < 3; round++) {
      press(stage());
      await flush(3000);
      stage().finish(`第 ${round} 題的答案。`);
      await flush(5000);
    }
    expect(net.tts).toEqual(["第 0 題的答案。", "第 1 題的答案。", "第 2 題的答案。"]);
    expect(FakeAudioContext.scheduled).toBeGreaterThanOrEqual(3);
    expect(calls.speechFailed).toBe(1);
    expect(net.tokenRequests).toBe(1);
    expect(sdk.sessions).toBe(0);

    // 切分頁：monogram 沒有 teardown，也不會回頭去要 token
    hide();
    press(stage());
    await flush(200_000);
    expect(net.tokenRequests).toBe(1);
    expect(calls.teardown).toBe(0);
  });

  it("S2 講到一半斷線：speechFailed 一次、同步回報 session 結束、之後都是 monogram；計時器一起停，之後不再收線", async () => {
    const { stage, calls, view } = await mount(LIVE);
    await flush(200);
    expect(sdk.log).toContain("attach");
    expect(view().videoVisible).toBe(true);

    press(stage());
    await flush(3000);
    stage().finish("講到一半的答案。");
    await flush(0);
    expect(calls.speaking.at(-1)).toBe(true);

    sdk.emit("session_disconnected", "UNKNOWN_REASON");
    expect(net.closeCalls).toBe(1); // 🔴 斷線的當下、任何 await 之前就回報
    await flush(0);
    expect(calls.speechFailed).toBe(1);
    expect(calls.speaking.at(-1)).toBe(false);
    expect(view()).toMatchObject({ video: false, monogram: true });
    expect(net.closeBodies.join()).toContain("sess-1");
    // 機制（第二道，soft）：降級的這一刻不可以還有待觸發的計時器
    expect.soft(vi.getTimerCount(), "降級之後還有待觸發的計時器").toBe(0);

    const degradedAt = traces.length;
    await flush(80_000); // 斷線前最後一次活動 +75 秒：舊的閒置計時器還在的話會觸發
    expect(calls.teardown).toBe(0);
    press(stage());
    await flush(3000);
    stage().finish("斷線之後的答案。");
    await flush(5000);
    await flush(100_000); // 接通 +178 秒：舊的上限計時器還在的話會觸發
    // 行為：降級之後不可以再跑收線（它在 monogram 上唯一的痕跡是一筆「畫面切回靜態照片」假紀錄）
    expect(traces.slice(degradedAt).filter((t) => t.startsWith(TEARDOWN_TRACE))).toEqual([]);
    expect(calls.teardown).toBe(0);
    expect(net.tokenRequests).toBe(1);
    expect(sdk.sessions).toBe(1);
    expect(calls.speechFailed).toBe(1);
    expect(net.tts).toEqual(["講到一半的答案。", "斷線之後的答案。"]);
    expect(FakeAudioContext.scheduled).toBeGreaterThanOrEqual(1);
  });

  it("S3 切分頁 teardown：同步回報 session 結束、收掉串流；下一次按說話照舊重建 heygen", async () => {
    const { stage, calls, view, hide } = await mount(LIVE);
    await flush(200);
    expect(sdk.sessions).toBe(1);
    hide();
    expect(net.closeCalls).toBe(1); // 🔴 同步：切走的當下就送，不等 destroy
    await flush(0);
    expect(calls.teardown).toBe(1);
    expect(sdk.log).toContain("session.stop");
    expect(net.closeBodies.join()).toContain("sess-1");
    press(stage());
    await flush(200);
    expect(net.tokenRequests).toBe(2);
    expect(sdk.sessions).toBe(2);
    expect(view()).toMatchObject({ video: true, videoVisible: true, monogram: false });
  });

  it("S4 接通途中被收掉（切分頁）：舊的 prepare 回來之後不開計時器、不標影像就緒", async () => {
    const token = gate();
    net.tokenGate = token.promise;
    const { stage, calls, view, hide } = await mount(LIVE);
    await flush(200);
    expect(net.tokenRequests).toBe(1);
    hide(); // 接通途中
    await flush(0);
    expect(calls.teardown).toBe(1);
    token.release();
    await flush(0);
    expect(view().videoVisible).toBe(false);
    net.tokenGate = null;
    await flush(10_000);
    press(stage()); // 新的 session 在 +10 秒接上
    await flush(200);
    expect(sdk.log.filter((x) => x === "attach")).toHaveLength(1);
    await flush(70_000); // 距離第一次（被收掉的）prepare 約 80 秒、距離新 session 約 70 秒
    expect(calls.teardown).toBe(1);
  });

  it("S5 teardown 之後的 reportActivity 不可以把停掉的閒置計時器叫回來；新 session 的閒置從它接通那一刻算", async () => {
    const { stage, calls, hide } = await mount(LIVE);
    await flush(200);
    hide();
    await flush(0);
    expect(calls.teardown).toBe(1);
    // 機制（第二道，soft）：沒有 session 的時候，reportActivity 不可以生出任何計時器
    const timers = vi.getTimerCount();
    stage().reportActivity();
    expect.soft(vi.getTimerCount(), "teardown 之後 reportActivity 叫回了計時器").toBe(timers);

    const token = gate();
    net.tokenGate = token.promise;
    press(stage());
    await flush(10_000);
    token.release(); // 新 session 在 +10 秒才接上 → 它自己的閒置是 +85 秒
    await flush(200);
    await flush(70_000); // +80 秒
    expect(calls.teardown).toBe(1);
    await flush(10_000); // +90 秒：新 session 自己的閒置到點
    expect(calls.teardown).toBe(2);
  });

  it("S6 /chat（沒指定 provider、不 autoStart）：monogram、不要 token、朗讀出聲、朗讀按鈕可用", async () => {
    const { stage, calls, view } = await mount({});
    await flush(200);
    expect(view()).toMatchObject({ video: false, monogram: true });
    expect(calls.audioAvailable.at(-1)).toBe(true);
    stage().unlockAudio();
    void stage().prepare();
    await flush(0);
    stage().finish("文字對談的答案。");
    await flush(5000);
    expect(net.tokenRequests).toBe(0);
    expect(sdk.sessions).toBe(0);
    expect(net.tts).toEqual(["文字對談的答案。"]);
    expect(calls.speechFailed).toBe(0);
  });

  it("S7 連線中答案在排隊、token 被拒：speechFailed 恰一次、降級後不補說那一則；下一次按之後正常出聲", async () => {
    const token = gate();
    net.tokenGate = token.promise;
    net.token = [503];
    const { stage, calls, view } = await mount(LIVE);
    await flush(200);
    press(stage());
    await flush(3000);
    stage().finish("連線中到的答案。");
    await flush(0);
    token.release();
    await flush(200);
    expect(calls.speechFailed).toBe(1);
    expect(view()).toMatchObject({ video: false, monogram: true });
    await flush(10_000);
    expect(net.tts).toEqual([]);
    press(stage());
    await flush(3000);
    stage().finish("下一題。");
    await flush(5000);
    expect(net.tts).toEqual(["下一題。"]);
    expect(calls.speechFailed).toBe(1);
    expect(net.tokenRequests).toBe(1);
  });

  it("S8 切分頁收掉之後 token 才被拒（prepare 在 destroy 之後失敗）：不降級，下一次按照舊重建 heygen", async () => {
    const token = gate();
    net.tokenGate = token.promise;
    net.token = [503];
    const { stage, calls, view, hide } = await mount(LIVE);
    await flush(200);
    hide();
    await flush(0);
    token.release();
    await flush(200);
    expect(view()).toMatchObject({ video: true, monogram: false });
    net.tokenGate = null;
    press(stage());
    await flush(200);
    expect(net.tokenRequests).toBe(2);
    expect(sdk.sessions).toBe(1);
    expect(view()).toMatchObject({ video: true, videoVisible: true });
    expect(calls.speechFailed).toBe(0);
  });

  it("S9 卸載時計時器還在：到點不可以丟錯、不可以回報 teardown", async () => {
    const { calls, unmount } = await mount(LIVE);
    await flush(200);
    expect(sdk.log).toContain("attach");
    unmount();
    await flush(0);
    expect(sdk.log).toContain("session.stop");
    await flush(200_000);
    expect(calls.teardown).toBe(0);
    // ⚠️ 卸載只 destroy、不回報 session 結束（既有行為，範圍外的已知缺口）。故意不斷言，修掉的時候在這裡補。
  });

  it("S10 斷線之後、monogram 還沒建好就按說話：那一題沒聲音但要明講一次，不在手勢外開 AudioContext；下一次按就恢復", async () => {
    // 真的瀏覽器裡 preloadMonogram 讓 monogram 在同一個 task 的 microtask 裡就進 driverRef，click 插不進去；
    // 這道縫只剩「預載還沒完就斷線」。這裡用「同一個 task 裡按下去」代表「按鍵落在 monogram 建好之前」。
    const { stage, calls } = await mount(LIVE);
    await flush(200);
    sdk.emit("session_disconnected", "UNKNOWN_REASON");
    press(stage()); // driverRef 還是 null：手勢裡的 unlockAudio 落空
    await flush(3000);
    stage().finish("這一題的答案。");
    await flush(5000);
    expect(calls.speechFailed).toBe(1);
    expect(net.tts).toEqual([]);
    expect(FakeAudioContext.count).toBe(0); // 🔴 不可以為了補救在手勢外開 AudioContext

    press(stage());
    await flush(3000);
    stage().finish("再下一題。");
    await flush(5000);
    expect(net.tts).toEqual(["再下一題。"]);
    expect(FakeAudioContext.count).toBe(1);
    expect(FakeAudioContext.scheduled).toBeGreaterThanOrEqual(1);
    expect(calls.speechFailed).toBe(1);
    expect(net.tokenRequests).toBe(1);
    expect(sdk.sessions).toBe(1);
  });

  it("S11 切分頁回來按說話、接通卡住超過 75 秒：接通途中不可以被閒置計時器收掉（閒置從接通那一刻才算）", async () => {
    // LiveStage.press 先 reportActivity 再 prepare：被叫回來的舊閒置計時器 75 秒後到點；
    // 接通完成時 prepare 會先收掉舊的再開新的，所以只有「接通還沒完成就到點」會出事。
    const { stage, calls, view, hide } = await mount(LIVE);
    await flush(200);
    hide();
    await flush(0);
    expect(calls.teardown).toBe(1);
    stage().finish("切回來才到的答案。"); // 沒有 driver：明講沒聲音（也是一次活動）
    expect(calls.speechFailed).toBe(1);
    await flush(1000);

    const start = gate();
    sdk.startGate = start.promise; // LiveAvatar 的 start() 卡住
    press(stage());
    await flush(76_000); // 按下 +76 秒：還在接
    expect(calls.teardown).toBe(1);
    start.release();
    await flush(200);
    expect(view()).toMatchObject({ video: true, videoVisible: true });
    expect(sdk.log.filter((x) => x === "attach")).toHaveLength(2);
    await flush(76_000); // 接通 +76 秒：新 session 自己的閒置到點（照常）
    expect(calls.teardown).toBe(2);
  });

  it("S12 呼叫端只呼叫 prepare()、前面沒有 reportActivity：切分頁後有過活動，72 秒後重接、接通要 5 秒——接通途中不可以被收掉", async () => {
    const { stage, calls, view, hide } = await mount(LIVE);
    await flush(200);
    hide();
    await flush(0);
    expect(calls.teardown).toBe(1);
    stage().push("切回來之後");
    stage().finish("切回來之後的答案。"); // 活動；沒有 driver，明講沒聲音
    expect(calls.speechFailed).toBe(1);
    await flush(72_000);

    const token = gate();
    net.tokenGate = token.promise;
    stage().unlockAudio();
    void stage().prepare(); // 不先 reportActivity（ChatPanel「開啟朗讀」的順序）
    await flush(5_000); // 距離上一次活動 +77 秒：還在接
    expect(calls.teardown).toBe(1);
    token.release();
    await flush(200);
    expect(view()).toMatchObject({ video: true, videoVisible: true });
    expect(sdk.log.filter((x) => x === "attach")).toHaveLength(2);
  });

  it("S13 違約的 driver 在 monogram 接手之後又報一次 fatal：當成過期回報不理，已經被手勢解鎖的老師聲音照常出聲", async () => {
    const { stage, calls } = await mount(LIVE);
    await flush(200);
    sdk.emit("session_disconnected", "UNKNOWN_REASON"); // 第一次（合法的）回報 → 降級，monogram 接手
    await flush(0);
    press(stage()); // 手勢解鎖 monogram
    await flush(1000);
    expect(heygenHooks).toHaveLength(1);
    heygenHooks[0].onFatal(new Error("同一個 heygen driver 遲到的第二次回報"));
    await flush(2000);
    stage().finish("這一題的答案。");
    await flush(5000);
    expect(net.tts).toEqual(["這一題的答案。"]);
    expect(calls.speechFailed).toBe(0);
    expect(FakeAudioContext.count).toBe(1);
    expect(net.tokenRequests).toBe(1);
  });

  it("S14 違約的 driver 在被收掉（切分頁 destroy）之後才報 fatal：不可以降級；下一次按照舊重建 heygen", async () => {
    const { stage, calls, view, hide } = await mount(LIVE);
    await flush(200);
    hide();
    await flush(0);
    expect(calls.teardown).toBe(1);
    expect(heygenHooks).toHaveLength(1);
    heygenHooks[0].onFatal(new Error("destroy 之後才報"));
    await flush(0);
    expect(view()).toMatchObject({ video: true, monogram: false });
    press(stage());
    await flush(200);
    expect(net.tokenRequests).toBe(2);
    expect(view()).toMatchObject({ video: true, videoVisible: true, monogram: false });
  });

  it("S15 離開頁面（pagehide）：當下同步送出 session 結束，接著收掉串流", async () => {
    const { calls, leavePage } = await mount(LIVE);
    await flush(200);
    leavePage();
    expect(net.closeCalls).toBe(1); // 🔴 分頁隨時會被殺掉：回報一定要在第一個 await 之前送出
    await flush(0);
    expect(net.closeBodies.join()).toContain("sess-1");
    expect(sdk.log).toContain("session.stop");
    expect(calls.teardown).toBe(1);
  });
});
