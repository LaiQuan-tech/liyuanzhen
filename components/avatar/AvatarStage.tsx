"use client";

import dynamic from "next/dynamic";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import DigitalAvatar from "@/components/avatar/DigitalAvatar";
import { resolveProvider } from "@/lib/avatar";
import type { AvatarProvider, AvatarState } from "@/lib/avatar";
import { createStageSession, type StageCallbacks } from "@/lib/avatar/stage-session";
import { FullBodyStage, STAGE_MASK, type Pose } from "./full-body-stage";

/**
 * 語音頁（/live、/live2、/live3）與 /chat 的頭像舞台：畫面（交叉淡入、「李」字、全身合成、浮水印）＋接線。
 *
 * 🔴 driver 生命週期的編排不在這裡（2026-09-30 起）：接通、閒置與上限計時器、切分頁／離開頁面收線並回報帳本、
 * 執行期 onFatal 降級成 monogram，全部在 lib/avatar/stage-session.ts——從這個檔案「只搬不改寫」抽出去的，
 * 註解與教訓都跟著搬過去了，改行為之前先讀那份。這個元件只做四件事：
 * 1. 用 useState 的惰性初始化為每個 mount 建一個 session（建構是純的，StrictMode 跑兩次初始化也沒事）
 * 2. 把最新的 callback props 寫進同一個可變物件交給 session（取代原本的四個 callback ref）
 * 3. 三個 effect 只轉呼叫：掛載（mount／unmount）、切分頁與離開頁面（teardown）、自動連線（autoStart）
 * 4. imperative handle 同步轉給 session（prepare 的手勢同步段要在 handle.prepare() return 之前做完）
 * 跟抽出來之前的語意差異列在 stage-session.ts 的檔頭。
 *
 * 測試：components/avatar/AvatarStage.harness.test.ts（假 React 跑真的元件＋真的 session＋真的 driver；
 * 抽 session 之前寫的特性測試，這次重構一個字都沒改照綠）。
 */

/**
 * VideoAvatar 只在瀏覽器端載入。Phase 2 之後這條路會把 livekit / webrtc-adapter
 * 一起帶進來，那是經典的 SSR 地雷（`window is not defined`）。
 * 在還沒裝 SDK 的現在就先把邊界劃好，比裝完再來救便宜得多。
 */
const VideoAvatar = dynamic(
  () => import("@/components/avatar/VideoAvatar").then((m) => m.default),
  { ssr: false }
);

export interface AvatarStageHandle {
  /** ⚠️ 必須在使用者手勢的呼叫堆疊裡呼叫。冪等。 */
  /**
   * 接通串流。`unmute: true` 時同時解除靜音——那一段必須在使用者手勢裡呼叫。
   * 自動連線請不要帶 unmute，見 AvatarStage 的 autoStart 說明。
   */
  prepare(options?: { unmute?: boolean }): Promise<void>;
  /**
   * 只解鎖這一頁的音訊輸出（monogram 的 AudioContext），不開任何計費 session。
   *
   * 🔴 必須在點擊處理的**第一段同步**呼叫，任何 await 之前。/chat 在「開啟朗讀」與
   * 每一次送出問題都呼叫它：朗讀要等整段答案出來才開口，那時早就離開手勢了，
   * AudioContext 只能在這兩下點擊的當下開起來或 resume。
   *
   * 可選：ChibiStage（/live4）也實作 AvatarStageHandle，它自己在 prepare({ unmute }) 裡 prime。
   */
  unlockAudio?(): void;
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
  const videoRef = useRef<HTMLVideoElement>(null);

  // callback props 放進一個每次 render 都更新的可變物件，session 在呼叫當下才讀：
  // 避免它們每次 render 變新函式就把整個 driver 重建一次（原本是四個 callback ref，語意相同）
  const callbacks = useRef<StageCallbacks>({ onSpeakingChange }).current;
  callbacks.onSpeakingChange = onSpeakingChange;
  callbacks.onAudioAvailableChange = onAudioAvailableChange;
  callbacks.onTeardown = onTeardown;
  callbacks.onSpeechFailed = onSpeechFailed;

  const [provider, setProvider] = useState<AvatarProvider>(() => providerOverride ?? resolveProvider());
  const needsVideo = provider !== "monogram";

  /**
   * 這個 mount 的編排（見 lib/avatar/stage-session.ts）。
   *
   * ⚠️ 用 useState 的惰性初始化，一個 mount 只建一次：不要用 useMemo（React 可以丟掉它的快取重算），
   * 也不要在 render 裡直接呼叫（每次 render 都會多建一個）。StrictMode 開發模式會把初始化函式跑兩次、
   * 丟掉其中一個——所以 createStageSession 必須是純的（不建 driver、不開計時器、不掛監聽）。
   * providerOverride 只在這裡讀一次，見 stage-session.ts 檔頭差異 ②。
   */
  const [session] = useState(() =>
    createStageSession({
      providerOverride,
      callbacks,
      ui: { setVideoReady, setProvider },
      getVideo: () => videoRef.current,
    })
  );

  // driver 生命週期。⚠️ 不在這裡 prepare()——那必須由使用者手勢觸發，
  // 而 reactStrictMode 會讓 effect 跑兩次，等於開兩個計費 session（session.mount 可以重入、只建一個 driver）。
  // ⚠️ deps 只能放不會變的東西：這個 effect 重跑，cleanup 就會把正在用的 driver destroy 掉。
  useEffect(() => {
    session.mount();
    return () => session.unmount();
  }, [session]);

  // 分頁被切到背景還在燒串流，是網站跟展場 kiosk 最大的成本差異。
  // pagehide 而不是 unload——bfcache 之下 unload 不保證會跑。
  useEffect(() => {
    if (!needsVideo) return;

    const onHidden = () => {
      if (document.visibilityState === "hidden") void session.teardown("切到背景分頁");
    };
    const onPageHide = () => void session.teardown("離開頁面");

    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [needsVideo, session]);

  // 自動連線：等得到 <video> 才接、一個 mount 只做一次，都在 session.autoStart 裡（說明也在那裡）。
  // cleanup 取消等待中的輪詢。
  useEffect(() => {
    if (!autoStart) return;
    return session.autoStart();
  }, [autoStart, session]);

  // 🔴 每個方法都同步轉給 session，中間不可以有 await：prepare 的手勢同步段（解除靜音、unlockAudio）
  // 要在 handle.prepare() return 之前做完——見 AvatarStageHandle.prepare／unlockAudio。
  useImperativeHandle(
    ref,
    () => ({
      prepare: (options) => session.prepare(options),
      push: (delta) => session.push(delta),
      finish: (fullText) => session.finish(fullText),
      stop: () => session.stop(),
      unlockAudio: () => session.unlockAudio(),
      reportActivity: () => session.reportActivity(),
    }),
    [session]
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
          - 但 `setProvider("monogram")` 是**執行期**觸發的（見 ensureDriver 的 onFatal），
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
