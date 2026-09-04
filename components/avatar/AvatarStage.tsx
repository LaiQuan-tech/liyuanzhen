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
import { trace } from "@/lib/trace";
import { FullBodyStage, STAGE_MASK, type Pose } from "./full-body-stage";

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
  /**
   * 接通串流。`unmute: true` 時同時解除靜音——那一段必須在使用者手勢裡呼叫。
   * 自動連線請不要帶 unmute，見 AvatarStage 的 autoStart 說明。
   */
  prepare(options?: { unmute?: boolean }): Promise<void>;
  push(delta: string): void;
  finish(fullText: string): void;
  stop(): void;
  /**
   * 告訴閒置計時器「使用者還在」。
   *
   * push/finish 內部已經會呼叫，這支是給**不經過它們**的互動用的——
   * /live 的錄音就是：訪客講了 10 秒（切換式最長 45 秒），期間一個字都沒送進來，
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
  /**
   * 一掛載就自動接串流（不等使用者手勢）。
   *
   * ⚠️ **只給 /live 用。** `/chat` 也掛這個元件，那邊自動連等於費用直接翻倍，
   * 而且 /chat 的主體本來就是文字，沒有臉也完全能用。
   *
   * ⚠️ 自動連線一個 mount 只做一次。閒置被收掉之後**不會**自動再連——
   * 會的話一個沒人看的分頁可以無上限地一直重連燒錢。收掉之後 poster 會淡回來，
   * 使用者按下去才重接。
   */
  autoStart?: boolean;
  /**
   * 串流還沒接上時鋪在底層的靜態畫面。
   *
   * ⚠️ 這張是 avatar 的**來源照片**（真實攝影，從 LiveAvatar 的 preview_url 取得），
   * 不是影片的一格。所以它**不掛**「AI 生成影像」浮水印——
   * 那個標記是給即時對嘴影片用的，因為影片裡那些話不是她說的；
   * 一張她本人的照片沒有那個問題，硬掛上去反而是在說一句假話。
   * 同樣的判準寫在 content/homepage.ts 的 PORTRAIT 註解裡。
   */
  poster?: string;
  /**
   * 全身合成模式（只有 size="full" 用得到）。
   *
   * 開著的話畫面不再是滿版的一張臉，而是一張她站著的全身底圖 ＋ 疊在頭部
   * 位置的即時串流。做這件事的理由、代價與對位方法全部寫在
   * ./full-body-stage.tsx 的檔頭，改動前先讀那份。
   *
   * ⚠️ 收的是**姿勢物件不是布林**（`POSE_SEATED` / `POSE_STANDING`）。
   * 底圖、poster、影片框三樣綁在同一個物件裡，就是為了不讓它們各自漂移——
   * 換底圖忘了換 poster 的話，串流接上的瞬間臉會跳而畫面上看不出原因。
   * 呼叫端要用 `pose.poster` 傳 poster，不要自己寫死字串。
   */
  fullBody?: Pose;
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
    autoStart = false,
    poster,
    fullBody,
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
   * 目前這個計費 session 的 id。收線時要回報給伺服器。
   *
   * 🔴 沒有這一段的那段期間，帳本記得到「開了幾個 session」，記不到「用了幾分鐘」。
   * 實測正式站 88 筆裡 billed_minutes 有值的是 0 筆，而未結算的列在預算計算裡
   * 一律以單次上限（3 分鐘）估算——實際多半遠低於此，帳因此嚴重高估。
   */
  const sessionIdRef = useRef<string | null>(null);

  /**
   * 通知伺服器「這個 session 結束了」。
   *
   * ⚠️ 一定要用 `sendBeacon`。收線最常見的觸發點是 `pagehide`（關分頁、切走），
   * 那個時候一般的 fetch 會跟著分頁一起被殺掉——而那正是我們最需要這個訊號的時刻。
   * sendBeacon 就是為了這個情境存在的：交給瀏覽器背景送，不受分頁生命週期影響。
   *
   * ⚠️ 只送 id，不送時長。時長由伺服器用 started_at 算——
   * 這一支端點沒有身分驗證，收下客戶端自報的秒數等於讓對方決定我們的帳。
   */
  const reportSessionClosed = useCallback((sessionId: string) => {
    const body = JSON.stringify({ sessionId });
    try {
      if (navigator.sendBeacon?.(
        "/api/avatar-session/close",
        new Blob([body], { type: "application/json" })
      )) {
        return;
      }
    } catch {
      // 落到下面的 fetch
    }
    // 退路。keepalive 讓它在分頁關閉之後仍有機會送出，但不如 sendBeacon 可靠。
    void fetch("/api/avatar-session/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  }, []);

  /**
   * 使用者用手勢解除過靜音了嗎。
   *
   * 🔴 這個 ref 存在的理由是 SDK 會在我們背後改 `<video>.muted`。
   * livekit 的 attachToElement（index.esm.js:11488）寫死：
   *     element.muted = mediaStream.getAudioTracks().length === 0;
   * 串流帶音軌就是 false。也就是每一次 attach() 都會把影片解除靜音。
   *
   * 自動連線那一次沒有使用者手勢，而 Chrome 的自動播放政策不准一個
   * **不靜音**的影片播放——結果是串流接上了、也在計費，畫面卻停在 poster。
   * 所以 attach() 之後必須把靜音狀態按「使用者到底按過沒有」重新蓋回去。
   */
  const unmutedRef = useRef(false);

  /**
   * 收掉會計費的 session。
   *
   * ⚠️ driver 物件在這裡是**丟掉**的（destroy 之後它永久失效），
   * 下一次手勢由 `ensureDriver()` 重新建一個。原本的註解寫「保留 driver 物件」，
   * 但程式其實是清成 null，而 driver 只在掛載時建立一次——
   * 那就是「切一次分頁之後影像再也回不來」的成因。
   */
  const teardown = useCallback(async (why = "未註明") => {
    idleRef.current?.stop();
    if (capRef.current) {
      clearTimeout(capRef.current);
      capRef.current = null;
    }
    preparingRef.current = null;
    // ⚠️ 這一行就是「臉又變回靜態照片」的那一刻，所以它**在早退之前**就要留痕。
    // 前一版只在成功收掉 session 之後才記，於是「沒有 driver 可收」那條路
    // 會把畫面切回 poster 卻不留任何紀錄——查起來就跟臉從來沒出現過一樣。
    setVideoReady(false);

    const driver = driverRef.current;
    if (!driver?.metered) {
      trace("畫面切回靜態照片", `${why}（沒有計費中的 session 要收）`, "warn");
      return;
    }
    driverRef.current = null;
    sessionLimitRef.current = null;

    // 🔴 回報要在 await 之前、而且是同步的。
    // pagehide 觸發時分頁隨時會被殺掉，await 之後的程式碼不保證跑得到——
    // 那正是最需要這個訊號的時刻（訪客直接關分頁）。
    const closedId = sessionIdRef.current;
    sessionIdRef.current = null;
    if (closedId) reportSessionClosed(closedId);

    await driver.destroy();
    trace("串流被收掉", why, "warn");
    speakingCb.current(false);
    // 串流沒了還留著上一輪的字幕，畫面會停在訪客無法理解的中間態
    teardownCb.current?.();
  }, [reportSessionClosed]);

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
   * 它自己的註解與畫面上的「點一下按鈕就可以重新開始」都是做不到的承諾。
   *
   * ⚠️ 這也表示 onFatal（含 SESSION_DISCONNECTED）之後，下一次點按鈕會重新
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
          onSessionOpened: (sessionId) => {
            sessionIdRef.current = sessionId;
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
      if (document.visibilityState === "hidden") void teardown("切到背景分頁");
    };
    const onPageHide = () => void teardown("離開頁面");

    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [needsVideo, teardown]);

  const prepare = useCallback(async (options: { unmute?: boolean } = {}) => {
    // ⚠️ 解除靜音要做兩件事，順序都不能動：
    //
    // 1. 必須在手勢的**同步**段落做完——await 之後就不算使用者手勢了
    // 2. 必須在下面 preparingRef 的早退**之前**。自動連線那一次還在飛的時候
    //    使用者就按了下去，早退會讓那一次永遠不解除靜音，她就一直是無聲的
    //
    // 自動連線（autoStart）不帶 unmute：`<video>` 本來就是 muted + autoPlay，
    // 靜音播放不需要手勢，所以連得上、看得到，只是沒有聲音。
    if (options.unmute) {
      unmutedRef.current = true;
      const video = videoRef.current;
      if (video) {
        video.muted = false;
        video.play().catch(() => {
          // 靜默失敗看起來就跟壞掉一樣，所以要留痕跡
          console.warn("[avatar] 自動播放被擋，需要使用者再點一次");
        });
      }
    }

    // 正在備就不要再備一次。少了它就有 double-spend race。
    if (preparingRef.current) return preparingRef.current;

    const video = videoRef.current;

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

      // 🔴 attach() 之後把靜音狀態蓋回去，見 unmutedRef 的說明。
      // 沒有這幾行，自動連線接上的串流在真實 Chrome 上是**播不動**的：
      // SDK 把它解除靜音了，而沒有手勢的不靜音影片不准播。
      if (video) {
        video.muted = !unmutedRef.current;
        video.play().catch((error) => {
          // 靜默失敗看起來就跟壞掉一樣，所以要留痕跡
          trace("attach 之後 play() 被擋", String(error), "error");
        });
      }

      availableCb.current?.(driver.audioAvailable);

      if (driver.metered) {
        trace("畫面換成即時影像");
        setVideoReady(true);
        idleRef.current = createIdleTimer(IDLE_MS, () => void teardown("閒置逾時"));
        idleRef.current.start();

        // 伺服器說了算。⚠️ 提早 2 秒收手，讓我們自己乾淨地關掉 session，
        // 而不是等對方把連線切斷——後者在畫面上是「突然斷掉」，
        // 前者才有機會顯示「連線已結束，點一下按鈕可以重新開始」。
        const limit = sessionLimitRef.current;
        const capMs = limit ? Math.max(5_000, limit * 1000 - 2_000) : FALLBACK_CAP_MS;
        capRef.current = setTimeout(() => void teardown("撞到單次時間上限"), capMs);
      }
    })();

    preparingRef.current = run;
    try {
      await run;
    } finally {
      if (preparingRef.current === run) preparingRef.current = null;
    }
  }, [ensureDriver, teardown, videoReady]);

  /**
   * 自動連線。
   *
   * ⚠️ **一定要等 `<video>` 出現才能呼叫 prepare()。**
   * `VideoAvatar` 走 next/dynamic，元件掛載的當下那個 <video> 還不存在，
   * 於是 prepare() 會撞到「driver 需要 <video> 但 videoRef 是空的」那道護欄
   * 直接中止——而且旗標已經立起來，永遠不會重試。
   * 實測就是這樣：poster 出得來、`/api/avatar-token` 一次都沒發。
   * 那道護欄是對的（沒有 video 就開計費 session 等於對著黑畫面燒錢），
   * 錯的是觸發時機。
   *
   * ⚠️ 一個 mount 只做一次。閒置被收掉之後**不會**自動重連——
   * 會的話一個沒人看的分頁可以無上限地一直重連燒錢。
   *
   * ⚠️ deps 只放 `autoStart`。`prepare` 的 deps 含 videoReady，接通之後它會變成
   * 新的函式；把它放進 deps 會讓這個 effect 重跑並中斷等待中的輪詢，所以走 ref。
   */
  const autoStartedRef = useRef(false);
  const prepareRef = useRef(prepare);
  prepareRef.current = prepare;
  useEffect(() => {
    if (!autoStart) return;
    let cancelled = false;

    void (async () => {
      // 最多等 4 秒。等不到就放棄——使用者按下去時 videoRef 一定已經在了。
      for (let i = 0; i < 40 && !cancelled && !videoRef.current; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (cancelled || autoStartedRef.current) return;
      if (!videoRef.current) {
        trace("自動連線放棄：4 秒內等不到 <video>", undefined, "error");
        return;
      }
      autoStartedRef.current = true;
      void prepareRef.current();
    })();

    return () => {
      cancelled = true;
    };
  }, [autoStart]);

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
        const driver = driverRef.current;
        if (!driver) {
          // 🔴 沒有 driver 就沒有人能說這句話。**不可以**靜靜地丟掉。
          //
          // 這條路真的走得到：onFatal（含斷線）會把 driverRef 清成 null 並降級成
          // monogram，而那之後送進來的每一則答案都會消失。畫面上的樣子是
          // 「文字出來了、她一個字都沒說、沒有任何解釋」——正好就是使用者
          // 一直在回報的症狀，而且從畫面上完全無法跟麥克風的問題區分。
          trace("答案沒有 driver 可送，這一段不會有聲音", `${fullText.length} 字`, "error");
          speechFailedCb.current?.();
          return;
        }
        driver.finish(fullText);
      },
      stop: () => driverRef.current?.stop(),
      reportActivity: () => idleRef.current?.reportActivity(),
    }),
    [prepare]
  );

  if (size === "full") {
    // 滿版舞台。同樣是兩層交叉淡入，但底層是置中的「李」字標記而不是同尺寸的圖，
    // 因為一張 128px 的圖放大到整個螢幕只會糊掉。

    /**
     * 全身合成要成立，兩個條件缺一不可。
     *
     * 🔴 `needsVideo` 這半不能省。降級成 monogram 時（額度用完／關閉／載入失敗）
     * 臉是**不會動**的，這時候鋪一張她的全身照上去，等於用一張靜態照片
     * 假裝數位人還在——比單純顯示「李」字標記更會誤導人。
     */
    // ⚠️ 用一個變數同時當「要不要合成」與「用哪一組幾何」。
    // 分成 boolean ＋ 物件兩個變數的話，總有一天會出現「開著合成但幾何是舊的」。
    const pose = fullBody && needsVideo ? fullBody : undefined;

    return (
      <div className="absolute inset-0 overflow-hidden bg-ink">
        {/*
          滿版的場景背景（`/live3` 的街景）。鋪在所有東西之下。

          🔴 **掛載條件用 `fullBody`，顯示條件用 `pose`**，兩者不同是刻意的：
          - `pose`（＝ `fullBody && needsVideo`）在降級成 monogram 時會變成
            undefined。那時候街景要一起消失——人不見了、街還在，畫面會是
            一條空街上浮著一個「李」字，看起來像合成壞掉而不是刻意的降級。
          - 但 `setProvider("monogram")` 是**執行期**觸發的（見上面斷線那段），
            直接卸載會讓整片街景在一格內變黑，更像當機。所以保持掛載、
            用 opacity 過渡，跟底下的交叉淡入同樣 700ms。

          ⚠️ `bg-ink` 保留不動。黑邊的成因不是它存在，是沒有東西蓋住它；
          這一層 `absolute inset-0` 蓋滿之後它自動看不見。留著換到三件事：
          背景板解碼前不會閃出 body 的淡紫 `--bg`（而這張板子就是 LCP）、
          降級時的正確底色、板子 404 時的正確底色。

          ⚠️ 不要加 `loading="lazy"`：這一頁同時在搶四秒內開起計費 session，
          背景板要跟 HTML 一起被 preload scanner 抓到。
        */}
        {fullBody?.background && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={fullBody.background}
            alt=""
            fetchPriority="high"
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover transition-opacity duration-700"
            style={{ opacity: pose ? 1 : 0 }}
          />
        )}

        {/*
          全身底圖。刻意鋪在交叉淡入的兩層**之下**，而且整頁只有這一份。

          ⚠️ 不要為了寫起來順手而把它塞進下面任何一層：放進去的話身體會跟著
          臉一起淡入淡出，而且兩層同時半透明的那一瞬間，整個人會暗一下
          （0.5 疊 0.5 不等於 1）。身體是靜態的，本來就不該參與交叉淡入。
        */}
        {pose && (
          <FullBodyStage>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={pose.src}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
          </FullBodyStage>
        )}

        <div
          className="absolute inset-0 transition-opacity duration-700"
          style={{ opacity: videoReady ? 0 : 1 }}
          aria-hidden={videoReady}
        >
          {/*
            🔴 poster 只在「正在連線」時用，降級一定要回到「李」字。
            兩者的意思完全相反：
              needsVideo（heygen）還沒接上 → 臉等一下就會動，放靜態臉是對的
              provider 是 monogram（額度用完／關閉／降級）→ 臉**不會**動了，
                這時候放一張靜態臉等於騙訪客有數位人
          */}
          {poster && needsVideo ? (
            <>
              {pose ? (
                /*
                  合成模式：poster 只佔頭部那一格，位置與遮罩必須跟 VideoAvatar
                  裡的影片**完全一致**，否則串流接上的瞬間臉會位移或閃一下邊。
                  兩邊poster 與影片共用 STAGE_BOX / STAGE_MASK，理由（實測輪廓只差 1~2px）
                  寫在 full-body-stage.tsx 那組常數上。
                */
                <FullBodyStage>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={poster}
                    alt=""
                    className="absolute object-cover"
                    style={{
                      ...pose.box,
                      maskImage: STAGE_MASK,
                      WebkitMaskImage: STAGE_MASK,
                    }}
                  />
                </FullBodyStage>
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={poster} alt="" className="h-full w-full object-cover" />
              )}
              {/*
                🔴 poster 階段也要有浮水印。
                這張本身是真實照片（不是 AI 生成的一格），照理不需要標記——
                首頁那張就沒有。但 /live 整頁就是數位人的舞台，一張佔滿螢幕的臉
                被錄下來轉傳時，看的人不會去分辨那一格是照片還是算圖。
                揭露這件事寧可從嚴：少標一次的代價，比多標一次大得多。

                🔴 合成模式下這條**更**不能拿掉：底下那張全身圖的胸部以下是
                AI 生成的，不是她本人的照片。整個畫面裡真正屬於真實攝影的
                只有頭部那一小塊。

                🔴 `/live3` 把背景換成真實街景之後，這件事的風險又升一級：
                棚拍背景一看就知道是製作出來的，但貼上街景之後整張畫面會被讀成
                「一張她站在某條真實街道上的照片」。而首頁那張是**她本人真的
                站在那面牆前**，兩者只隔一次點擊、隔著同一面牆。
                這條浮水印是唯一在畫面上說明差別的東西。

                ⚠️ 樣式與 top-16 要跟 VideoAvatar 那份一致，否則兩層交叉淡入時
                浮水印會在畫面上跳一下。改一邊記得改另一邊。
              */}
              <span className="pointer-events-none absolute right-3 top-16 rounded-full bg-ink/80 px-3 py-1 text-[11px] font-bold tracking-wide text-white backdrop-blur-sm">
                AI 生成影像
              </span>
            </>
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <DigitalAvatar state={state} size="lg" showLabel={false} />
            </div>
          )}
        </div>

        {needsVideo && (
          // videoRef 是一般 prop，不是 ref——理由寫在 VideoAvatar 的 props 註解裡
          <VideoAvatar
            videoRef={videoRef}
            state={state}
            size="full"
            visible={videoReady}
            fullBody={pose}
          />
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
