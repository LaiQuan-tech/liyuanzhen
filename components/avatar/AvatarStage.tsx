"use client";

import dynamic from "next/dynamic";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import DigitalAvatar from "@/components/avatar/DigitalAvatar";
import { createAvatarDriver, resolveProvider } from "@/lib/avatar";
import type { AvatarDriver, AvatarProvider, AvatarState } from "@/lib/avatar";
import { createIdleTimer } from "@/lib/idle-timer";

/**
 * VideoAvatar 只在瀏覽器端載入。Phase 2 之後這條路會把 livekit / webrtc-adapter
 * 一起帶進來，那是經典的 SSR 地雷（`window is not defined`）。
 * 在還沒裝 SDK 的現在就先把邊界劃好，比裝完再來救便宜得多。
 */
const VideoAvatar = dynamic(
  () => import("@/components/avatar/VideoAvatar").then((m) => m.default),
  { ssr: false }
);

/** 多久沒互動就收掉串流。太短會在使用者讀答案時斷掉，太長就是在燒錢。 */
const IDLE_MS = 75_000;
/**
 * 單次 session 硬上限的**保底值**。防的是「開著分頁去吃飯」這種沒有惡意的燒錢方式。
 *
 * ⚠️ 真正說了算的是伺服器回的 max_session_duration（見 hooks.onSessionLimit）。
 * 這個常數只在伺服器沒給值時才用得到。兩邊不一致的症狀是
 * 「她講到一半突然消失，畫面沒有任何解釋」——多輪對話一定會撞到。
 */
const FALLBACK_CAP_MS = 5 * 60_000;

export interface AvatarStageHandle {
  /** ⚠️ 必須在使用者手勢的呼叫堆疊裡呼叫。冪等。 */
  prepare(): Promise<void>;
  push(delta: string): void;
  finish(fullText: string): void;
  stop(): void;
  /**
   * 告訴閒置計時器「使用者還在」。
   *
   * push/finish 內部已經會呼叫，這支是給**不經過它們**的互動用的——
   * /live 的按住說話就是：訪客講了 10 秒，期間一個字都沒送進來，
   * 沒有這支的話閒置計時器會在他講話的時候把串流收掉。
   */
  reportActivity(): void;
}

interface Props {
  state: AvatarState;
  size?: "sm" | "lg" | "full";
  onSpeakingChange(speaking: boolean): void;
  /** 這個 driver 在這台裝置上發不發得出聲音——決定要不要顯示朗讀按鈕 */
  onAudioAvailableChange?(available: boolean): void;
  /**
   * 指定 driver，蓋過 NEXT_PUBLIC_AVATAR_PROVIDER。
   *
   * 存在的理由：/live 是為串流虛擬人設計的整頁體驗，沒有那張臉這一頁就沒有意義；
   * 而 /chat 有文字版可用，維持環境變數決定即可。兩頁需求不同，
   * 用一個全域環境變數綁在一起只會逼人二選一。
   */
  provider?: AvatarProvider;
  /**
   * 計費中的 session 被收掉了（閒置、切到背景、離開頁面、撞到硬上限）。
   *
   * /live 用它把對話狀態一起重設——串流沒了還留著上一輪的字幕，
   * 畫面會停在一個訪客無法理解的中間態。
   */
  onTeardown?(): void;
  /**
   * 影像還在、但這一段話沒有聲音（多半是 /api/tts 失敗）。
   * ⚠️ 沒有人接這個回呼的話，訪客得到的就是完全沉默 ＋ 零解釋。
   */
  onSpeechFailed?(): void;
}

const AvatarStage = forwardRef<AvatarStageHandle, Props>(function AvatarStage(
  {
    state,
    size = "sm",
    onSpeakingChange,
    onAudioAvailableChange,
    provider: providerOverride,
    onTeardown,
    onSpeechFailed,
  },
  ref
) {
  const [videoReady, setVideoReady] = useState(false);
  const driverRef = useRef<AvatarDriver | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const preparingRef = useRef<Promise<void> | null>(null);
  const idleRef = useRef<ReturnType<typeof createIdleTimer> | null>(null);
  const capRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // callback props 放進 ref：避免它們每次 render 變新函式就把整個 driver 重建一次
  const speakingCb = useRef(onSpeakingChange);
  speakingCb.current = onSpeakingChange;
  const availableCb = useRef(onAudioAvailableChange);
  availableCb.current = onAudioAvailableChange;

  const [provider, setProvider] = useState(() => providerOverride ?? resolveProvider());
  const needsVideo = provider !== "monogram";

  const teardownCb = useRef(onTeardown);
  teardownCb.current = onTeardown;
  const speechFailedCb = useRef(onSpeechFailed);
  speechFailedCb.current = onSpeechFailed;

  /** 伺服器說這個 session 能活多久。null ＝ 還沒拿到 token，用保底值。 */
  const sessionLimitRef = useRef<number | null>(null);

  /**
   * 收掉會計費的 session。
   *
   * ⚠️ driver 物件在這裡是**丟掉**的（destroy 之後它永久失效），
   * 下一次手勢由 `ensureDriver()` 重新建一個。原本的註解寫「保留 driver 物件」，
   * 但程式其實是清成 null，而 driver 只在掛載時建立一次——
   * 那就是「切一次分頁之後影像再也回不來」的成因。
   */
  const teardown = useCallback(async () => {
    idleRef.current?.stop();
    if (capRef.current) {
      clearTimeout(capRef.current);
      capRef.current = null;
    }
    preparingRef.current = null;
    setVideoReady(false);

    const driver = driverRef.current;
    if (!driver?.metered) return;
    driverRef.current = null;
    sessionLimitRef.current = null;
    await driver.destroy();
    speakingCb.current(false);
    // 串流沒了還留著上一輪的字幕，畫面會停在訪客無法理解的中間態
    teardownCb.current?.();
  }, []);

  /**
   * 元件已經卸載。⚠️ 用 ref 不用區域變數——`ensureDriver()` 會在 effect 之外
   * （使用者按下按鈕時）被呼叫，區域變數在那個時候看不到。
   */
  const unmountedRef = useRef(false);
  /**
   * 正在建立的那一次。⚠️ 這道 guard 不可以拿掉：
   * StrictMode 會讓 effect 跑兩次，少了它就是兩個計費 session。
   */
  const creatingRef = useRef<Promise<AvatarDriver | null> | null>(null);

  /**
   * 拿到一個可用的 driver，沒有就建一個。冪等。
   *
   * ⚠️ 這裡從 mount-only 的 effect 抽出來，是為了修一個真實的 bug：
   * `teardown()` 會把 driverRef 清成 null 並 `destroy()`（destroy 之後那個物件
   * 永久失效），而 driver 原本只在掛載時建立一次。結果是**任何一次 teardown
   * 之後影像就再也回不來**——而 teardown 會在切到別的分頁時觸發。
   * 它自己的註解與畫面上的「按住說話就可以重新開始」都是做不到的承諾。
   *
   * ⚠️ 這也表示 onFatal（含 SESSION_DISCONNECTED）之後，下一次按住說話會重新
   * 建立 driver、重新開一個計費 session。那是刻意的：斷線本來就該能重來，
   * 而且它由使用者的手勢觸發，帳本那三道閘門仍然守著。
   */
  const ensureDriver = useCallback(async (): Promise<AvatarDriver | null> => {
    if (driverRef.current) return driverRef.current;
    if (creatingRef.current) return creatingRef.current;

    const run = (async () => {
      const driver = await createAvatarDriver(
        {
          onSpeakingChange: (s) => {
            if (!unmountedRef.current) speakingCb.current(s);
          },
          onSpeechFailed: () => {
            if (!unmountedRef.current) speechFailedCb.current?.();
          },
          onSessionLimit: (seconds) => {
            // 只記下來，武裝硬上限是 prepare() 的事——這個回呼會在
            // fetchToken() 期間觸發，那時候計時器還沒開始
            if (!unmountedRef.current) sessionLimitRef.current = seconds;
          },
          onFatal: (error) => {
            if (unmountedRef.current) return;
            console.error("[avatar] driver 失效，降級為 monogram：", error);
            // 降級：使用者失去的是那張臉，不是整個聊天
            void driverRef.current?.destroy();
            driverRef.current = null;
            preparingRef.current = null;
            setVideoReady(false);
            setProvider("monogram");
          },
        },
        providerOverride
      );

      if (unmountedRef.current) {
        void driver.destroy();
        return null;
      }
      driverRef.current = driver;
      setProvider(driver.provider);

      if (driver.metered) {
        // 串流虛擬人自己帶聲音，跟這台裝置有沒有裝中文語音無關——
        // 所以不用等 prepare（那要手勢）就能確定朗讀按鈕該顯示
        availableCb.current?.(true);
      } else {
        // monogram 不計費也不需要手勢，直接備好；
        // 它的可用性**取決於裝置**（沒有中文語音就是 false），必須問過才知道
        await driver.prepare(null);
        if (!unmountedRef.current) availableCb.current?.(driver.audioAvailable);
      }
      return driver;
    })().finally(() => {
      creatingRef.current = null;
    });

    creatingRef.current = run;
    return run;
  }, [providerOverride]);

  // driver 生命週期。⚠️ 不在這裡 prepare()——那必須由使用者手勢觸發，
  // 而 reactStrictMode 會讓 effect 跑兩次，等於開兩個計費 session。
  useEffect(() => {
    unmountedRef.current = false;
    void ensureDriver();

    return () => {
      unmountedRef.current = true;
      const driver = driverRef.current;
      driverRef.current = null;
      void driver?.destroy();
    };
  }, [ensureDriver]);

  // 分頁被切到背景還在燒串流，是網站跟展場 kiosk 最大的成本差異。
  // pagehide 而不是 unload——bfcache 之下 unload 不保證會跑。
  useEffect(() => {
    if (!needsVideo) return;

    const onHidden = () => {
      if (document.visibilityState === "hidden") void teardown();
    };
    const onPageHide = () => void teardown();

    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [needsVideo, teardown]);

  const prepare = useCallback(async () => {
    // 正在備就不要再備一次。少了它就有 double-spend race。
    if (preparingRef.current) return preparingRef.current;

    // ⚠️ 解除靜音必須在手勢的**同步**段落做完，await 之後就不算手勢了。
    // 所以這一段一定要在 ensureDriver() 之前，不可以往下搬進 run。
    const video = videoRef.current;
    if (video) {
      video.muted = false;
      video.play().catch(() => {
        // 靜默失敗看起來就跟壞掉一樣，所以要留痕跡
        console.warn("[avatar] 自動播放被擋，需要使用者再點一次");
      });
    }

    const run = (async () => {
      // ⚠️ driver 可能是 null——teardown 之後我們刻意把它丟掉。
      // 這裡重新建一個，否則切一次分頁影像就再也回不來。
      const driver = driverRef.current ?? (await ensureDriver());
      if (!driver) return;
      // 已經備好了就不用再開一個計費 session
      if (driver.metered && videoReady) return;

      if (driver.needsVideo && !video) {
        // 絕對不能靜默放行：計費的 session 會照樣開起來，然後對著一個
        // 不存在的 <video> 串流，畫面全黑。這種錯誤要在開發時就吵。
        console.error(
          "[avatar] driver 需要 <video> 但 videoRef 是空的——" +
            "多半是 ref 沒穿過 next/dynamic 的包裝。中止 prepare，不開 session。"
        );
        return;
      }

      await driver.prepare(video ?? null);
      availableCb.current?.(driver.audioAvailable);

      if (driver.metered) {
        setVideoReady(true);
        idleRef.current = createIdleTimer(IDLE_MS, () => void teardown());
        idleRef.current.start();

        // 伺服器說了算。⚠️ 提早 2 秒收手，讓我們自己乾淨地關掉 session，
        // 而不是等對方把連線切斷——後者在畫面上是「突然斷掉」，
        // 前者才有機會顯示「連線已結束，按住說話可以重新開始」。
        const limit = sessionLimitRef.current;
        const capMs = limit ? Math.max(5_000, limit * 1000 - 2_000) : FALLBACK_CAP_MS;
        capRef.current = setTimeout(() => void teardown(), capMs);
      }
    })();

    preparingRef.current = run;
    try {
      await run;
    } finally {
      if (preparingRef.current === run) preparingRef.current = null;
    }
  }, [ensureDriver, teardown, videoReady]);

  useImperativeHandle(
    ref,
    () => ({
      prepare,
      push: (delta) => {
        idleRef.current?.reportActivity();
        driverRef.current?.push(delta);
      },
      finish: (fullText) => {
        idleRef.current?.reportActivity();
        driverRef.current?.finish(fullText);
      },
      stop: () => driverRef.current?.stop(),
      reportActivity: () => idleRef.current?.reportActivity(),
    }),
    [prepare]
  );

  if (size === "full") {
    // 滿版舞台。同樣是兩層交叉淡入，但底層是置中的「李」字標記而不是同尺寸的圖，
    // 因為一張 128px 的圖放大到整個螢幕只會糊掉。
    return (
      <div className="absolute inset-0 overflow-hidden bg-ink">
        <div
          className="absolute inset-0 flex items-center justify-center transition-opacity duration-700"
          style={{ opacity: videoReady ? 0 : 1 }}
          aria-hidden={videoReady}
        >
          <DigitalAvatar state={state} size="lg" showLabel={false} />
        </div>

        {needsVideo && (
          // videoRef 是一般 prop，不是 ref——理由寫在 VideoAvatar 的 props 註解裡
          <VideoAvatar videoRef={videoRef} state={state} size="full" visible={videoReady} />
        )}
      </div>
    );
  }

  return (
    // 兩層疊在同一個 grid cell 上做交叉淡入：串流就緒前先看到「李」字標記，
    // 客戶不會看到一個黑框。串流掛掉時也是原地淡回去，不會跳版。
    <div className="grid">
      <div
        className="transition-opacity duration-500"
        style={{ gridArea: "1 / 1", opacity: videoReady ? 0 : 1 }}
        aria-hidden={videoReady}
      >
        <DigitalAvatar state={state} size={size} />
      </div>

      {needsVideo && (
        <div style={{ gridArea: "1 / 1" }}>
          {/* videoRef 是一般 prop，不是 ref——理由寫在 VideoAvatar 的 props 註解裡 */}
          <VideoAvatar
            videoRef={videoRef}
            state={state}
            size={size}
            visible={videoReady}
          />
        </div>
      )}
    </div>
  );
});

export default AvatarStage;
