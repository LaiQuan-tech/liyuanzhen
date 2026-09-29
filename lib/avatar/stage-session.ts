import { createAvatarDriver } from "@/lib/avatar";
import type { AvatarDriver, AvatarDriverHooks, AvatarProvider } from "@/lib/avatar";
import { isCurrentDriver, nextDriverProvider, shouldHandleFatal } from "@/lib/avatar/fallback";
import { createIdleTimer } from "@/lib/idle-timer";
import { trace } from "@/lib/trace";

/**
 * AvatarStage 的 driver 生命週期編排：接通串流、閒置與上限計時器、切分頁／離開頁面時收線並回報帳本、
 * 執行期 onFatal 之後降級成 monogram（「李」字＋老師的克隆聲）。
 *
 * 2026-09-30 從 components/avatar/AvatarStage.tsx「只搬不改寫」抽出來：狀態變數名與 `.current` 寫法、
 * await 結構、手勢同步段的位置、trace 字串、註解都照搬，拿 db896b6 的元件逐段對照就看得出每一段從哪裡來。
 * 註解裡原本講 React 機制（deps、useCallback、「一定要是 ref」）的句子改寫成在這裡仍然成立的說法，教訓都留著。
 * 抽出來的理由是測得到：vitest 是 node 環境、沒有 jsdom，元件本身只能靠假 React 的治具測。
 *
 * 這個模組不 import React。元件（components/avatar/AvatarStage.tsx）交給它的是：
 * - callbacks：元件每次 render 都寫進最新 callback props 的可變物件（取代元件原本的四個 callback ref）
 * - ui：setVideoReady／setProvider，也就是元件的 React state——畫面靠它們重繪
 * - getVideo：讀元件的 videoRef（<video> 留在元件，它是 VideoAvatar 的 prop）
 * - providerOverride：頁面指定的 driver（見差異 ②）
 * - createDriver：可注入，預設就是 lib/avatar 的 createAvatarDriver。正式碼不帶，只有測試會換
 *
 * 🔴 建構（createStageSession）必須是純的：不建 driver、不開計時器、不掛監聽。那些都在 mount()、prepare()、
 * autoStart() 裡，由元件的 effect 或使用者手勢觸發（StrictMode 開發模式會把 useState 的初始化函式跑兩次、
 * 丟掉其中一個 session）。mount()／unmount() 可以重入：StrictMode 的 mount→unmount→mount 只會建一個 driver
 * （creatingRef 去重）。unmount() 跟元件版一樣只 destroy，不回報 session 結束（已知缺口，另案處理）。
 *
 * ── 跟 db896b6 元件版的語意差異（就這三條，其他沒有）─────────────────
 * ① prepare 裡「已經備好了就不用再開一個計費 session」的早退，改讀 session 自己的 videoReadyRef。
 *    元件版讀的是 prepare 這個 useCallback 閉包裡、上一次 render 的 videoReady：從 setVideoReady 到重繪提交
 *    （handle 換成新的 prepare）之間，它是舊值。現在 setVideoReady 的當下就更新，比原本即時。
 *    那個空窗裡進來的 prepare()，元件版會多跑一輪（接通後：重排閒置與上限計時器；teardown 後：誤以為還備著而不重建），
 *    現在不會。空窗只有一次重繪那麼長：autoStart 落不進去；點擊很少見但落得進去——setVideoReady 發生在
 *    promise 或計時器裡（接通回來、閒置／上限收線）時，React 18 另排一個任務重繪，已經排隊的點擊可以搶在它前面。
 *    閒置／上限收線後剛好在那一下按說話，元件版那一下等於沒按（建了 driver 卻早退），現在會正常接通。
 * ② providerOverride 在一個 session 的生命週期內固定（建構時讀一次）。元件版的 ensureDriver 把它放在 useCallback
 *    的 deps 裡，頁面在 mount 期間換了 provider，會讓掛載 effect 重跑（destroy 舊的、照新的建）；現在不會。
 *    目前的呼叫端都是常數（LiveStage 的 LIVE_PROVIDER；ChatPanel 不帶），行為不變。
 * ③ imperative handle 物件在一個 mount 內只建一次。元件版的 handle 依賴 prepare，videoReady 一變就換一個新物件。
 *    呼叫端（LiveStage、ChatPanel）都是當下讀 stageRef.current 再呼叫，看不到差別。
 * 其他都一樣：同一套 await、同一個時點讀 <video>、同一個時點回報帳本、同一組計時器、同一批 trace。
 *
 * 測試：
 * - ./stage-session.test.ts：劇本式假 driver 的單元測試（每一項修正、StrictMode、<video> 晚到、手勢同步段、同步回報）
 * - ./stage-session.scenarios.test.ts：真的 driver＋假 SDK 跑 S1–S15 情境（從舊治具原樣移植）
 * - components/avatar/AvatarStage.harness.test.ts：元件的接線（session 是假的）。抽出這個模組的時候它還是完整的
 *   特性測試，一個字都沒改照綠（完整版在新增這個檔案的那個 commit：git log --diff-filter=A -- lib/avatar/stage-session.ts）
 */

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

/** 元件的四個 callback props（說明在 AvatarStage 的 Props）。元件每次 render 都把最新的寫進同一個物件。 */
export interface StageCallbacks {
  onSpeakingChange(speaking: boolean): void;
  onAudioAvailableChange?(available: boolean): void;
  onTeardown?(): void;
  onSpeechFailed?(): void;
}

/** 元件的 React state。畫面（交叉淡入、「李」字、VideoAvatar 掛不掛）只看這兩個。 */
export interface StageUi {
  setVideoReady(ready: boolean): void;
  setProvider(provider: AvatarProvider): void;
}

export type CreateAvatarDriver = (
  hooks: AvatarDriverHooks,
  provider?: AvatarProvider
) => Promise<AvatarDriver>;

export interface StageSessionOptions {
  /** 頁面指定的 driver（AvatarStage 的 `provider` prop）。見差異 ②：建構時讀一次 */
  providerOverride?: AvatarProvider;
  callbacks: StageCallbacks;
  ui: StageUi;
  /** 讀元件的 videoRef.current。⚠️ 每次都要讀當下的值，不可以在建構時存下來（見 autoStart） */
  getVideo(): HTMLVideoElement | null;
  /** 只給測試換。預設就是 createAvatarDriver（它 dynamic import 各個 driver 模組） */
  createDriver?: CreateAvatarDriver;
}

export interface StageSession {
  /** 元件掛載（掛載 effect）：建 driver。可以重入 */
  mount(): void;
  /** 元件卸載（掛載 effect 的 cleanup）：只 destroy */
  unmount(): void;
  /** 收掉會計費的 session。元件的 visibilitychange／pagehide 監聽器呼叫；閒置與上限計時器也走這裡 */
  teardown(why?: string): Promise<void>;
  /** 自動連線（元件的 autoStart effect）。回傳取消函式（effect 的 cleanup） */
  autoStart(): () => void;
  /** 以下是 AvatarStageHandle 的內容，說明在元件那邊。⚠️ 元件必須同步轉呼叫 */
  prepare(options?: { unmute?: boolean }): Promise<void>;
  unlockAudio(): void;
  push(delta: string): void;
  finish(fullText: string): void;
  stop(): void;
  reportActivity(): void;
}

/** 可變的 `{ current }`，跟元件版的 useRef 同一個寫法，搬過來的程式碼一個字都不用改 */
interface Ref<T> {
  current: T;
}
function ref<T>(initial: T): Ref<T> {
  return { current: initial };
}

export function createStageSession(options: StageSessionOptions): StageSession {
  const { providerOverride, callbacks, ui, getVideo, createDriver = createAvatarDriver } = options;

  /**
   * 影像就緒了沒有（元件的 videoReady state 由 setVideoReady 同步更新，畫面照舊看 state）。
   * session 自己也記一份，給 prepare 的早退讀——見檔頭差異 ①。
   */
  const videoReadyRef = ref(false);
  const setVideoReady = (ready: boolean) => {
    videoReadyRef.current = ready;
    ui.setVideoReady(ready);
  };
  const setProvider = (provider: AvatarProvider) => ui.setProvider(provider);

  const driverRef = ref<AvatarDriver | null>(null);
  /**
   * 元件的 <video>（videoRef 留在元件，它是 VideoAvatar 的 prop）。唯讀，每次讀都是當下的值——
   * 跟元件版直接讀 videoRef.current 一樣，所以搬過來的程式碼照舊寫 `videoRef.current`、在同一個時點讀。
   */
  const videoRef = {
    get current(): HTMLVideoElement | null {
      return getVideo();
    },
  };
  const preparingRef = ref<Promise<void> | null>(null);
  const idleRef = ref<ReturnType<typeof createIdleTimer> | null>(null);
  const capRef = ref<ReturnType<typeof setTimeout> | null>(null);

  // callback props 放進 ref：避免它們每次 render 變新函式就把整個 driver 重建一次。
  // 元件每次 render 都把最新的寫進 callbacks；這四個唯讀的 ref 在呼叫當下才去讀（語意跟元件版的四個 callback ref 一樣）
  const speakingCb = {
    get current() {
      return callbacks.onSpeakingChange;
    },
  };
  const availableCb = {
    get current() {
      return callbacks.onAudioAvailableChange;
    },
  };
  const teardownCb = {
    get current() {
      return callbacks.onTeardown;
    },
  };
  const speechFailedCb = {
    get current() {
      return callbacks.onSpeechFailed;
    },
  };

  /** 伺服器說這個 session 能活多久。null ＝ 還沒拿到 token，用保底值。 */
  const sessionLimitRef = ref<number | null>(null);

  /**
   * 目前這個計費 session 的 id。收線時要回報給伺服器。
   *
   * 🔴 沒有這一段的那段期間，帳本記得到「開了幾個 session」，記不到「用了幾分鐘」。
   * 實測正式站 88 筆裡 billed_minutes 有值的是 0 筆，而未結算的列在預算計算裡
   * 一律以單次上限（3 分鐘）估算——實際多半遠低於此，帳因此嚴重高估。
   */
  const sessionIdRef = ref<string | null>(null);

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
  const reportSessionClosed = (sessionId: string) => {
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
  };

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
  const unmutedRef = ref(false);

  /**
   * 收掉會計費的 session。
   *
   * ⚠️ driver 物件在這裡是**丟掉**的（destroy 之後它永久失效），
   * 下一次手勢由 `ensureDriver()` 重新建一個。原本的註解寫「保留 driver 物件」，
   * 但程式其實是清成 null，而 driver 只在掛載時建立一次——
   * 那就是「切一次分頁之後影像再也回不來」的成因。
   */
  const teardown = async (why = "未註明") => {
    // ⚠️ 停掉之後要把 ref 清成 null。createIdleTimer 的 reportActivity() 就是「重排」，
    // 留著的話下一次按說話（LiveStage.press 會先 reportActivity）會把這個**已經停掉**的計時器
    // 重新開起來；新的 session 接上之後它就成了孤兒，75 秒後照樣觸發、把新的 session 收掉。
    idleRef.current?.stop();
    idleRef.current = null;
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
  };

  /**
   * 元件已經卸載（unmount() 之後、下一次 mount() 之前）。⚠️ 用 session 的欄位，不用 mount() 裡的區域變數——
   * `ensureDriver()` 會在 mount() 之外（使用者按下按鈕時）被呼叫，區域變數在那個時候看不到。
   */
  const unmountedRef = ref(false);
  /**
   * 正在建立的那一次。⚠️ 這道 guard 不可以拿掉：
   * StrictMode 會讓元件的掛載 effect 跑兩次（mount→unmount→mount，那時 driver 還沒建好），少了它就是兩個計費 session。
   */
  const creatingRef = ref<Promise<AvatarDriver | null> | null>(null);

  /**
   * 這個 mount 已經因為執行期 onFatal 降級過了：之後 ensureDriver() 一律建 monogram。
   *
   * 🔴 它是 session 的欄位，不可以搬回元件做成 React state。元件版的教訓：當時它一定要是 ref，
   * 因為 ensureDriver 是 useCallback；做成 state 就得放進 deps，旗標一變 ensureDriver 就換成新函式 →
   * 掛載 effect（deps [ensureDriver]）重跑 → 它的 cleanup 會把剛建好、正在用的 driver destroy 掉。
   * 現在元件的掛載 effect 只依賴 session（整個 mount 期間不變），任何會變的值都不可以放進那個 effect 的 deps，理由相同。
   */
  const degradedRef = ref(false);

  /**
   * 拿到一個可用的 driver，沒有就建一個。冪等。
   *
   * ⚠️ 這裡從 mount-only 的 effect 抽出來，是為了修一個真實的 bug：
   * `teardown()` 會把 driverRef 清成 null 並 `destroy()`（destroy 之後那個物件
   * 永久失效），而 driver 原本只在掛載時建立一次。結果是**任何一次 teardown
   * 之後影像就再也回不來**——而 teardown 會在切到別的分頁時觸發。
   * 它自己的註解與畫面上的「點一下按鈕就可以重新開始」都是做不到的承諾。
   * 所以閒置、撞到上限、切分頁的 teardown 之後，下一次點按鈕會重建 heygen、重開計費 session
   * （由使用者的手勢觸發，帳本那三道閘門仍然守著）。
   *
   * 🔴 但**執行期 onFatal 之後不是這樣**（2026-09-29 改）：token 被拒、額度用盡、SDK 載入失敗、
   * start／attach 失敗、斷線之後，這個 mount 內鎖定 monogram（「李」字＋老師的克隆聲），
   * 不再建 heygen，重新整理頁面才會再試影像。理由（完整版在 lib/avatar/fallback.ts）：
   * 斷線當下分不出暫時還是持續；每次重試都要鑄 token、可能開計費 session；
   * 而舊的「下一次按就重連」從來沒真的成功過——<video> 已經隨降級卸載，下一次按撞上
   * 「沒有 video 就不開 session」的護欄、那一題無聲也沒有提示，再下一次才真的去連。
   * 降級之後 driver 由下面 onFatal 立刻建好的 monogram 接手，見那裡的說明。
   */
  const ensureDriver = async (): Promise<AvatarDriver | null> => {
    if (driverRef.current) return driverRef.current;
    if (creatingRef.current) return creatingRef.current;

    const run = (async () => {
      /** 這一次建出來的 driver。hooks 比 driver 先建，所以 onFatal 要靠這個變數認出「是誰在報」 */
      let self: AvatarDriver | null = null;
      // （元件版這裡直接呼叫 createAvatarDriver；抽出來之後可以注入，預設就是它）
      const driver = await createDriver(
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
            // ① 已卸載、或回報的已經不是目前這個 driver（過期）→ 不理。
            //    否則晚到的舊回報會把下面剛換上的 monogram 當成失效的 driver 收掉。
            const stage = { unmounted: unmountedRef.current, current: driverRef.current };
            if (!self || !shouldHandleFatal(stage, self)) return;
            const failed = self;
            console.error("[avatar] driver 失效，降級為 monogram：", error);

            // ② 閒置與上限計時器停掉，ref 清成 null——reportActivity() 會把停掉的閒置計時器重新開起來
            //    （見 teardown），留著的話 75 秒後它會對著一個已經沒有 session 的畫面再收一次。
            idleRef.current?.stop();
            idleRef.current = null;
            if (capRef.current) {
              clearTimeout(capRef.current);
              capRef.current = null;
            }

            // ③ 同步回報 session 結束（理由同 teardown）：沒回報的那一筆，帳本以 3 分鐘上限估算，
            //    還會在「上限＋30 秒」內佔著一個並發名額。token 被拒的話根本沒有 id，不會送。
            const closedId = sessionIdRef.current;
            sessionIdRef.current = null;
            if (closedId) reportSessionClosed(closedId);

            // ④ 收掉失效的 driver。說話狀態與「這一則沒送到」driver 自己在 onFatal 之前報過了
            //    （lib/avatar/types.ts 的 onFatal 契約）。
            driverRef.current = null;
            preparingRef.current = null;
            sessionLimitRef.current = null;
            void failed.destroy();
            setVideoReady(false);

            // ⑤ 這個 mount 之後一律 monogram。setProvider 讓畫面立刻換成「李」字，不等 driver 建好
            degradedRef.current = true;
            setProvider("monogram");
            trace(
              "影像接不上，改用「李」字＋老師的聲音（重新整理頁面才會再試影像）",
              error.message,
              "error"
            );

            // ⑥ 立刻把 monogram 建好，讓下一次按說話時 prepare({ unmute: true }) 同步段的
            //    `driverRef.current?.unlockAudio?.()` 在手勢裡解鎖它的 AudioContext。
            //    🔴 這裡**不**解鎖、不 prepare：onFatal 一定發生在手勢之外，沒有手勢開出來的
            //    AudioContext 是 suspended、resume() 可能永遠不回來（Safari 尤其明確）。
            //    代價：降級之後、下一次按之前到的答案放不出聲音，由 monogram 自己回報 onSpeechFailed。
            //    建失敗（chunk 載不到）的話，finish() 走「沒有 driver」那條給提示，下一次 prepare 會再試。
            ensureDriver().catch((createError) => {
              console.error("[avatar] 降級用的 monogram 建不起來：", createError);
            });
          },
        },
        // 見檔頭差異 ②：providerOverride 是建構時讀的那一個
        nextDriverProvider(providerOverride, degradedRef.current)
      );
      self = driver;

      if (unmountedRef.current) {
        void driver.destroy();
        return null;
      }
      driverRef.current = driver;
      setProvider(driver.provider);

      if (driver.metered) {
        // 串流虛擬人自己帶聲音（跟著 <video> 走），跟這個瀏覽器能不能放 Web Audio 無關——
        // 所以不用等 prepare（那要手勢）就能確定朗讀按鈕該顯示
        availableCb.current?.(true);
      } else {
        // monogram 不計費，prepare 不需要手勢（它刻意不在這裡碰 AudioContext，
        // 那要等 unlockAudio）；它的可用性**取決於瀏覽器**（沒有 Web Audio 就是 false），
        // 必須問過才知道
        await driver.prepare(null);
        if (!unmountedRef.current) availableCb.current?.(driver.audioAvailable);
      }
      return driver;
    })().finally(() => {
      creatingRef.current = null;
    });

    creatingRef.current = run;
    return run;
    // （元件版這裡是 useCallback 的 deps：degradedRef 刻意不放進去，reportSessionClosed 是穩定的，
    // 所以 ensureDriver 不會換新、掛載 effect 不會重跑。搬進 session 之後它只有這一個，教訓見 degradedRef 的註解。）
  };

  const prepare = async (options: { unmute?: boolean } = {}) => {
    // ⚠️ 解除靜音要做兩件事，順序都不能動：
    //
    // 1. 必須在手勢的**同步**段落做完——await 之後就不算使用者手勢了
    // 2. 必須在下面 preparingRef 的早退**之前**。自動連線那一次還在飛的時候
    //    使用者就按了下去，早退會讓那一次永遠不解除靜音，她就一直是無聲的
    //
    // 自動連線（autoStart）不帶 unmute：`<video>` 本來就是 muted + autoPlay，
    // 靜音播放不需要手勢，所以連得上、看得到，只是沒有聲音。
    // （元件的 handle.prepare 同步轉呼叫這裡，所以這一段仍然在呼叫端的手勢堆疊裡。）
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
      // 🔴 語音頁的備援就靠這一行出聲。兩條路會讓語音頁的 driver 變成 monogram（克隆聲走 Web Audio，
      // 不走 <video>）：heygen 模組載入失敗（createAvatarDriver 降級），以及執行期 onFatal
      // （ensureDriver 的 onFatal 立刻建好一個）。它的 AudioContext 只能在手勢裡解鎖——
      // 而語音頁唯一的手勢就是說話按鈕：LiveStage.press() 同步呼叫 prepare({ unmute: true })。
      // 答案要等錄音、辨識、生成全跑完才到，那時早就離開手勢了，少了這行備援就是啞的。
      // 帶 unmute 才做，理由同上：沒帶代表呼叫端不在手勢裡（autoStart）。
      // heygen／mock 沒有實作 unlockAudio，這行對它們是 no-op。
      driverRef.current?.unlockAudio?.();
    }

    // 正在備就不要再備一次。少了它就有 double-spend race。
    if (preparingRef.current) return preparingRef.current;

    const video = videoRef.current;

    const run = (async () => {
      // ⚠️ driver 可能是 null——teardown 之後我們刻意把它丟掉。
      // 這裡重新建一個，否則切一次分頁影像就再也回不來。
      // （降級過的 mount 建的是 monogram，見 ensureDriver。）
      let driver: AvatarDriver | null;
      try {
        driver = driverRef.current ?? (await ensureDriver());
      } catch (error) {
        // chunk 載不到之類。LiveStage 是 `void prepare()`，丟出去就是 unhandled rejection；
        // 這一題會走 finish() 的「沒有 driver」提示，下一次按再試
        console.error("[avatar] driver 建不起來：", error);
        return;
      }
      if (!driver) return;
      // 已經備好了就不用再開一個計費 session
      // （讀 session 自己的 videoReadyRef，不是元件版閉包裡上一次 render 的 videoReady——見檔頭差異 ①）
      if (driver.metered && videoReadyRef.current) return;

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

      // 🔴 等待期間 stage 可能已經不拿著這個 driver 了：接通失敗或斷線（onFatal 降級）、
      // 切分頁／閒置（teardown）、卸載。那就什麼都不要碰——舊版照樣 setVideoReady(true)、
      // 開閒置與上限計時器，那兩個計時器沒有人收，到點會把之後新開的 session 收掉。
      if (!isCurrentDriver({ unmounted: unmountedRef.current, current: driverRef.current }, driver)) {
        trace("接通回來時這個 driver 已經被換掉，不動畫面", undefined, "warn");
        return;
      }

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
        // 照理這時候不會有舊的計時器（teardown 與 onFatal 都清掉了）；真有的話先收掉再換，
        // 直接蓋掉 ref 會讓舊的變成孤兒，到點把這個新的 session 收掉
        // （元件版只有 videoReady 閉包的舊值空窗能讓這一段跑第二次；session 讀自己的 videoReadyRef 之後走不到，
        // 這兩行只剩防呆，所以 stage-session.test.ts 沒有獨立測它。）
        idleRef.current?.stop();
        if (capRef.current) clearTimeout(capRef.current);
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
  };

  /**
   * 自動連線用：這個 mount 已經自動連過了沒有。
   *
   * ⚠️ 一個 mount 只做一次。閒置被收掉之後**不會**自動重連——
   * 會的話一個沒人看的分頁可以無上限地一直重連燒錢。
   */
  const autoStartedRef = ref(false);

  return {
    // driver 生命週期（元件的掛載 effect 呼叫）。⚠️ 不在這裡 prepare()——那必須由使用者手勢觸發，
    // 而 reactStrictMode 會讓掛載 effect 跑兩次（mount→unmount→mount），等於開兩個計費 session。
    mount() {
      unmountedRef.current = false;
      void ensureDriver();
    },
    // ⚠️ 跟元件版的 cleanup 一樣只 destroy：不停計時器、不把 videoReady 標回 false、不回報 session 結束（已知缺口，另案）。
    // 所以接通「之後」才發生的 unmount→mount（React 18 只有 StrictMode 會重播，而且只在第一次掛載、還沒接通的時候），
    // 重新 mount 之後 prepare 會以為還備著而早退，舊的計時器到點再收掉新建的 driver。現在的 React 18 走不到，
    // 換到會保留 state 卸載再掛回的機制（例如 Activity）之前要先處理。
    unmount() {
      unmountedRef.current = true;
      const driver = driverRef.current;
      driverRef.current = null;
      void driver?.destroy();
    },

    teardown,

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
     * ⚠️ 一個 mount 只做一次（autoStartedRef）。
     *
     * ⚠️ 元件的 autoStart effect 只能依賴不會變的東西（autoStart、session）。元件版的 prepare 是 useCallback、
     * deps 含 videoReady，接通之後會變成新的函式；放進 effect 的 deps 會讓它重跑並中斷等待中的輪詢，
     * 所以當時走 prepareRef。搬進 session 之後 prepare 只有這一個，這裡直接呼叫。
     */
    autoStart() {
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
        void prepare();
      })();

      return () => {
        cancelled = true;
      };
    },

    prepare,
    push: (delta) => {
      idleRef.current?.reportActivity();
      driverRef.current?.push(delta);
    },
    finish: (fullText) => {
      idleRef.current?.reportActivity();
      const driver = driverRef.current;
      if (!driver) {
        // 🔴 沒有 driver 就沒有人能說這句話。**不可以**靜靜地丟掉——畫面上的樣子會是
        // 「文字出來了、她一個字都沒說、沒有任何解釋」，從畫面上完全無法跟麥克風的問題區分。
        //
        // 現在走得到的時機（2026-09-29 起 onFatal 會立刻建 monogram 接手，這裡只剩縫隙）：
        // - onFatal 之後、monogram 還沒建好的那一瞬間（dynamic import 的往返），或它建不起來
        // - teardown（閒置、上限、切分頁）之後、下一次按說話重建之前
        // - 卸載之後
        trace("答案沒有 driver 可送，這一段不會有聲音", `${fullText.length} 字`, "error");
        speechFailedCb.current?.();
        return;
      }
      driver.finish(fullText);
    },
    stop: () => driverRef.current?.stop(),
    // 同步轉給 driver，中間不可以有 await——見 AvatarStageHandle.unlockAudio
    unlockAudio: () => driverRef.current?.unlockAudio?.(),
    reportActivity: () => idleRef.current?.reportActivity(),
  };
}
