/**
 * 把 `/api/tts` 的裸 PCM 串流同時做兩件事：排進喇叭、算出嘴型時間軸。
 *
 * `lib/avatar/lipsync.ts` 負責「這一幀該張多開」，這一支負責「那一幀在牆上時鐘的
 * 第幾秒發生」。兩支分開是刻意的：前者是純函式、node 環境可測；後者必須碰
 * `AudioContext`，只能在瀏覽器裡活著。所以這裡只寫排程與時間換算，不重算音量。
 *
 * ## 🔴 不可以收完再播
 *
 * `app/api/tts/route.ts` 的註解記著：非串流版讓端到端延遲變成 12.9 秒，其中
 * 7.8 秒發生在她開口之前。所以這裡是**收到一塊就排一塊**，第一塊排進去的當下
 * 就回報 `onFirstAudio`，後面的還在傳。任何「先 await 整條 stream 再播」的重構
 * 都會把那 7.8 秒加回來，而且症狀只是「感覺有點慢」，不會有錯誤訊息。
 *
 * ## ⚠️ 解碼不能用 `<audio>` 或 `decodeAudioData`；輸出只有 iOS 走 `<audio>`
 *
 * 這兩件事要分開講，不然會互相矛盾：
 *
 * **解碼**：`/api/tts` 回的是**裸 PCM**（16-bit LE / 24 kHz / mono，沒有 RIFF 檔頭，
 * 見 `lib/voice/pcm.ts` 的檔頭）。`<audio src>` 與 `decodeAudioData` 都要靠容器格式
 * 判斷取樣率與位元深度，餵裸 PCM 進去一律解不出來。所以走
 * `createBuffer` ＋ `AudioBufferSourceNode`，自己把 Int16 轉成 Float32。
 *
 * **輸出**：**只有 iOS／iPadOS** 的音訊圖不直接接喇叭，而是經 `createMediaStreamDestination()`
 * 接進一個 `<audio srcObject>` 元素——那是 iPhone 上「嘴在動但沒聲音」的修法。
 * 🔴 桌面與 Android 一律直接接 `ctx.destination`：2026-09-30 盲聽確認，桌面 Chrome 走
 * `<audio>` 那條路聲音會變悶、變老。兩邊的理由都在 `mediaDest` 欄位的註解，
 * 哪些裝置算 iOS 見 `shouldRouteThroughMediaElement`。
 *
 * ## ⚠️ 時間軸不是「開頭時間 ＋ atMs」
 *
 * 直覺會想記一個 `origin`（第一塊排進去的時刻），之後所有幀都用 `origin + atMs`。
 * 那在**沒有斷流**的前提下才成立。真實情況是網路會卡：卡超過 LEAD 之後
 * `Math.max(ctx.currentTime + LEAD, nextAt)` 會把下一塊往後推，音訊之間多出一段
 * 靜音，於是「第 5 秒的取樣」實際上在第 5.3 秒才出聲——嘴型會愈跑愈前面，
 * 而且卡得愈多偏得愈遠。
 *
 * 所以每一塊都自己算一次原點：
 *
 * ```
 * chunkOrigin = 這塊實際排定的播放時刻 − (這塊之前已排的取樣數 / 取樣率)
 * ```
 *
 * 這塊產出的幀就用這塊的原點換算。斷流之後原點自動往後跳，時間軸跟著修正，
 * 不需要偵測斷流、也不需要補償邏輯。
 */

import { LipSyncAnalyser, type Viseme } from "./lipsync";

/**
 * 取樣率。正本是 `lib/voice/pcm.ts` 的 `SAMPLE_RATE`，這裡刻意抄一份而不是 import：
 * 那支檔案的 `chunkPcm` 用到 node 的 `Buffer`，把它拉進瀏覽器 bundle 是自找麻煩，
 * 而它現在確實只被伺服器端與 scripts 引用（`lib/avatar/heygen.ts` 也是自己抄一份）。
 *
 * ⚠️ 三個數字都是 ElevenLabs `output_format=pcm_24000` 的規格，不能自己改。
 */
const SAMPLE_RATE = 24_000;
const BYTES_PER_SAMPLE = 2;
/** Int16 滿刻度。除以它就得到 Web Audio 要的 −1…1 */
const INT16_FULL_SCALE = 32_768;

/**
 * 排程前置量（秒）。每一塊都排在「現在 ＋ LEAD」之後，不是排在「現在」。
 *
 * ⚠️ 不要調到 0。`ctx.currentTime` 是上一次音訊執行緒回呼的時間，排在它身上等於
 * 排在過去——瀏覽器會直接把那塊當成「已經該播完了」而吃掉開頭，症狀是每塊的
 * 第一個字被削掉一點點，聽起來像有雜音。
 *
 * ⚠️ 也不要調大。這是硬加在首字延遲上的錢，而首字延遲正是這一頁要量的東西。
 * 80ms 是「夠躲過一次回呼抖動」與「量得出來的延遲」之間的取捨。
 */
const LEAD_SECONDS = 0.08;

/** 時間軸上的一格：從 `atSec` 開始，嘴型是這個 */
export interface VisemeCue {
  /** `AudioContext.currentTime` 座標系的絕對秒數 */
  atSec: number;
  viseme: Viseme;
  level: number;
}

/** `currentViseme()` 的回傳。沒在講話時是 closed / 0 */
export interface VisemeState {
  viseme: Viseme;
  level: number;
}

export interface LipSyncPlayerOptions {
  /** 每幀多長（毫秒），直接轉給 `LipSyncAnalyser`。預設 40 */
  frameMs?: number;
  /** 排程前置量（秒）。預設 0.08，理由見 `LEAD_SECONDS` */
  leadSeconds?: number;
}

const SILENT: VisemeState = { viseme: "closed", level: 0 };

/**
 * `shouldRouteThroughMediaElement` 要看的那幾樣東西，都來自 `navigator`。
 * 刻意是鬆的型別：node 測試可以直接塞物件；取不到 navigator（SSR）時整個傳 undefined。
 */
export interface MediaRouteEnv {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}

/**
 * 這台裝置的輸出要不要繞 `<audio>` 元素（`createMediaStreamDestination()` → `<audio srcObject>`）。
 *
 * 🔴 **只有 iOS／iPadOS 回 true**。繞路是 iPhone 非繞不可的修法，但桌面 Chrome 繞了聲音會變悶、
 * 變老（2026-09-30 盲聽），所以不是「繞了比較保險」——兩邊的理由都在 `LipSyncPlayer.mediaDest`。
 *
 * - UA 含 iPhone／iPad／iPod 就算。iPhone 上的 Chrome（UA 是 CriOS）也在內：
 *   iOS 版 Chrome 用的也是 WebKit，吃的是同一套坑。
 * - ⚠️ iPadOS 的 Safari 預設「要求桌面版網站」，UA 跟 Mac Safari **一字不差**，只能靠
 *   `platform === "MacIntel"` 且 `maxTouchPoints > 1` 認出來（Mac 沒有觸控螢幕，是 0）。
 *   兩個條件缺一不可：只看觸控點數，Android 與觸控筆電會被算進來；只看 platform，
 *   所有 Mac 都會被算進來——連 Mac 上的 node 都是（它的 `navigator.platform` 也是 "MacIntel"）。
 * - 取不到 UA（SSR、測試環境）一律 false：退回直接接 destination，不會炸。
 */
export function shouldRouteThroughMediaElement(env: MediaRouteEnv | null | undefined): boolean {
  if (!env) return false;
  const userAgent = typeof env.userAgent === "string" ? env.userAgent : "";
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return env.platform === "MacIntel" && (env.maxTouchPoints ?? 0) > 1;
}

/**
 * 從 `navigator` 讀出判斷要用的欄位；讀不到 UA 就回 undefined（判斷會當成非 iOS）。
 *
 * ⚠️ 讀這一步本身不可以丟例外：它跑在 `prime()` 裡，也就是使用者手勢的第一行。
 * /live4 的 ChibiStage.prepare 沒有接例外，炸了會連 LiveStage 的 press() 一起中斷；
 * monogram 的 unlockAudio 則會把它記成「AudioContext 開不起來」。所以每個欄位都先驗型別
 * （SSR 沒有 navigator；stage-session 的測試治具把 navigator 換成只有 sendBeacon 的物件）。
 */
function readMediaRouteEnv(): MediaRouteEnv | undefined {
  if (typeof navigator === "undefined" || !navigator) return undefined;
  // 用鬆的型別讀：`platform` 在 lib.dom 標成 deprecated，而且上面說的假物件欄位不齊
  const nav = navigator as unknown as { userAgent?: unknown; platform?: unknown; maxTouchPoints?: unknown };
  if (typeof nav.userAgent !== "string") return undefined;
  return {
    userAgent: nav.userAgent,
    platform: typeof nav.platform === "string" ? nav.platform : undefined,
    maxTouchPoints: typeof nav.maxTouchPoints === "number" ? nav.maxTouchPoints : undefined,
  };
}

/**
 * 一段話一個 `play()`。同一個 player 可以重複播，狀態每次重置。
 *
 * 典型用法：
 * ```ts
 * const player = new LipSyncPlayer();
 * const t0 = performance.now();
 * await player.play(res.body!, () => setLatencyMs(performance.now() - t0));
 * // 另一條 rAF 迴圈裡：
 * const { viseme, level } = player.currentViseme();
 * ```
 */
export class LipSyncPlayer {
  private readonly frameMs: number;
  private readonly leadSeconds: number;

  /**
   * ⚠️ 建構時**不開** `AudioContext`。瀏覽器的自動播放政策要求它在使用者手勢裡
   * 建立／resume，建構子通常發生在 render 期間——那時候開出來的 context 會是
   * `suspended`，而且再也回不來（Safari 尤其明確）。所以延到第一次 `play()` 才開。
   */
  private ctx: AudioContext | null = null;

  /**
   * 🔴 **只有 iOS／iPadOS** 的輸出不直接接 `ctx.destination`，而是經過一個 `<audio>` 元素；
   * 桌面、Android 直接接 `ctx.destination`，這兩個欄位維持 null。
   * 哪些裝置算 iOS 見 `shouldRouteThroughMediaElement`。
   *
   * **iOS 為什麼要繞**：這是 iPhone 上實際踩到的：**嘴在動、答案有出來、但沒有聲音**。
   * 嘴會動證明 context 是 running 的、音訊也排進去了——問題純粹在輸出端。
   * iOS 把「純 Web Audio」當成環境音（ambient）：
   *   - 靜音鍵會把它整個關掉
   *   - 頁面同時開著麥克風時，可能被路由到聽筒而不是喇叭
   * 而 `<audio>`／`<video>` 元素是「媒體播放」類別，兩者都不受影響——
   * 寫實版走 HeyGen 的 `<video>`，所以同一支手機上它有聲音、Q 版沒有。
   *
   * 解法是標準的：`createMediaStreamDestination()` 接一個 `<audio>` 元素，
   * 音訊圖的輸出就變成媒體播放。代價是多 20–60ms 的輸出延遲，
   * 低於一幀嘴型（40ms）的量級，實際聽不出來。
   *
   * **🔴 其他裝置為什麼不可以繞（2026-09-30 盲聽）**：使用者一直回報「數位人回答時有兩種聲音，
   * 一開始不像老師（比較老），後來才是」，換過 TTS 模型（v3 → v4）還是一樣。直接合成的音檔、
   * 在使用者 Chrome 裡攔到的原始 PCM、Web Audio 的排程（播放速率 1、沒有 detune、沒有重疊）
   * 全部正常。最後在使用者的 Mac Chrome 上盲聽 A/B：同一段 24 kHz 原始 PCM，
   * A 直接接 `ctx.destination`，B 走「MediaStreamDestination → `new Audio()` 的 `srcObject`」
   * （也就是這裡原本對所有裝置的接法），兩者都延遲 4 秒才開始播。使用者的判斷是
   * 「B 有老一點點，聲音比較悶」，選 A。
   * 結論：**桌面 Chrome 走這條 MediaStream 播放路徑，聲音會變悶、變老，使用者聽得出來**——
   * 問題不在 TTS。
   *
   * ⚠️ 不要為了「全平台一致」又把桌面改回 `<audio>`。一致的代價是每一位桌面訪客聽到的
   * 聲音都比較不像老師，而那正是使用者一路回報、換模型也修不掉的問題。
   *
   * ⚠️ 待辦：**iPhone 上這條路是不是也會悶，還沒實測**（上面的盲聽是在 Mac Chrome 上做的）。
   * iOS 仍然繞，因為「靜音鍵下沒聲音」比「悶一點」嚴重。可能的替代是
   * `navigator.audioSession.type = "playback"`（若它能讓純 Web Audio 在 iPhone 上被當成
   * 媒體播放，就不用繞 `<audio>`）——但要在 iPhone 實機上驗過「開著靜音鍵」與
   * 「頁面開著麥克風」兩個情境都有聲音、而且從喇叭出來，才能換。
   *
   * ⚠️ 元素的 `play()` 必須在使用者手勢裡呼叫（跟 resume 同一個理由），
   * 所以放在 `prime()`。沒有這一步，iOS 會拒絕播放，症狀跟修之前一模一樣。
   *
   * ⚠️ iOS 上兩個 API 缺任何一個也退回直接接 destination（沒有 `Audio`；
   * 太舊的瀏覽器沒有 MediaStreamDestination）。退回時只是回到修之前的行為，
   * 不會更糟。
   */
  private mediaDest: MediaStreamAudioDestinationNode | null = null;
  private audioEl: HTMLAudioElement | null = null;

  private analyser: LipSyncAnalyser | null = null;
  private timeline: VisemeCue[] = [];
  private sources: AudioBufferSourceNode[] = [];

  /** 下一塊最早可以排在哪（context 時間） */
  private nextAt = 0;
  /** 最後一塊的 chunkOrigin，`flush()` 的尾巴要用它換算 */
  private lastOriginSec = 0;
  /** 每幀秒數，`currentViseme()` 判斷最後一格何時結束要用 */
  private frameSec = 0.04;

  /**
   * 不滿一個取樣的半個 byte。
   *
   * ⚠️ 一定要留到下一塊再湊，不能丟也不能當成完整取樣。串流的切點跟 16-bit
   * 取樣邊界沒有任何關係，丟掉會讓**之後每一個 byte 都錯位一格**——高低位元組
   * 互換，整段從語音變成刺耳雜訊。這是 `lib/voice/pcm.ts` 的 `chunkPcm` 也在
   * 防的同一件事。
   */
  private tail = new Uint8Array(0);

  /**
   * 世代編號。`stop()` 會 ++，正在跑的 `play()` 迴圈每輪比對一次就知道自己過期了。
   * 用旗標不夠：`play()` 是 async，舊的迴圈可能在新的 `play()` 開始之後才醒來，
   * 那時候一個布林值分不出「該停」跟「新的正在跑」。
   */
  private generation = 0;
  private playing = false;

  constructor(options: LipSyncPlayerOptions = {}) {
    this.frameMs = options.frameMs ?? 40;
    this.leadSeconds = options.leadSeconds ?? LEAD_SECONDS;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /**
   * `AudioContext` 現在的狀態；還沒開過（沒 prime、沒 play）就是 null。
   *
   * 給「不在使用者手勢裡才要開始播」的呼叫端先問一聲（lib/avatar/monogram.ts）：
   * `play()` 遇到 suspended 會 `await ctx.resume()`，而沒有手勢的 resume() 可能**永遠不 resolve**——
   * 直接呼叫會讓整條朗讀卡住，畫面停在「回答中」。
   *
   * ⚠️ 只讀，不改任何行為。/live4（ChibiStage）沒有用到它。
   */
  get contextState(): AudioContextState | null {
    return this.ctx?.state ?? null;
  }

  /**
   * 已經排進播放圖、還沒播完的秒數（播放時鐘，不是牆上時鐘）。沒有東西在排就是 0。
   *
   * 🔴 `play()` 在**串流收完**時就 resolve，不是在聲音播完時（理由同 ChibiStage 的
   * SILENCE_HOLD_MS 註解）。要知道「她什麼時候講完」，得在 play() 之後再問這一支。
   *
   * ⚠️ 只讀，不改任何行為。monogram（/chat）與 /live4（ChibiStage，經 speech-stream.ts 的
   * speakWithPlayer）都靠它決定「長答案後段失敗時，等唸完才回報」。
   */
  get pendingSeconds(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    return Math.max(0, this.nextAt - ctx.currentTime);
  }

  /**
   * 在使用者手勢裡先把 `AudioContext` 開起來。
   *
   * 🔴 呼叫它的時機是**點擊處理函式的第一行，任何 await 之前**。
   *
   * 這是實作時踩到的坑：TTS 那條路是 `await fetch("/api/tts")` 拿到 body 之後才
   * `play()`，那個 await 已經離開使用者手勢，於是 context 一開出來就是 suspended、
   * `resume()` 被瀏覽器拒絕，**畫面上嘴在動但完全沒有聲音**——而且沒有任何錯誤，
   * 只有 console 一行 autoplay 警告。本機測試音那條路是同步的，所以會正常，
   * 兩條路表現不一致更容易把人帶去查錯的方向。
   *
   * 呼叫是冪等的，重複呼叫沒有副作用。
   */
  prime(): void {
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    // 🔴 這一行是 iOS 有沒有聲音的關鍵，理由見 `mediaDest` 的註解。
    // 冪等：已經在播的元素再 play() 一次是 no-op。非 iOS 沒有這個元素（null），這行什麼都不做。
    this.audioEl?.play().catch(() => {});
  }

  /**
   * 收一條裸 PCM 串流，邊排播放邊建時間軸。整條收完（或被 `stop()` 打斷）才 resolve。
   *
   * @param onFirstAudio 第一塊**排進**播放圖的那一刻呼叫一次。
   *   ⚠️ 這是「排進去」不是「出聲」——實際出聲還要再晚 `leadSeconds` 秒。
   *   量首字延遲時這個定義比較誠實：LEAD 是我們自己加的固定成本，不該混進
   *   「伺服器多久給出第一個 byte」裡面。
   */
  async play(stream: ReadableStream<Uint8Array>, onFirstAudio?: () => void): Promise<void> {
    // ⚠️ 這兩行必須在任何 await 之前。自動播放政策看的是「呼叫堆疊還在使用者
    // 手勢裡嗎」，一旦 await 過就不算了，context 會卡在 suspended 沒有聲音。
    const ctx = this.ensureContext();
    const resuming = ctx.state === "suspended" ? ctx.resume() : null;

    // 上一段可能還在播。先停乾淨再開新的——不然舊的 source 會脫離管理，
    // 之後 stop() 也停不掉它，兩段話會疊在一起講。
    this.stop();

    const generation = ++this.generation;
    this.playing = true;

    const analyser = new LipSyncAnalyser({ sampleRate: SAMPLE_RATE, frameMs: this.frameMs });
    this.analyser = analyser;
    this.frameSec = analyser.frameDurationMs / 1000;

    const reader = stream.getReader();
    let scheduledSamples = 0;
    let announced = false;

    try {
      if (resuming) await resuming;
      if (generation !== this.generation) return;

      for (;;) {
        const { done, value } = await reader.read();
        if (generation !== this.generation) return;

        if (value && value.byteLength > 0) {
          const pcm = this.takeSampleAligned(value);
          if (pcm.byteLength >= BYTES_PER_SAMPLE) {
            const startedAt = this.schedule(ctx, pcm);

            // 這塊自己的原點。斷流時 startedAt 會被往後推，原點跟著往後，
            // 時間軸自動修正——理由見檔頭。
            this.lastOriginSec = startedAt - scheduledSamples / SAMPLE_RATE;
            scheduledSamples += pcm.byteLength / BYTES_PER_SAMPLE;

            if (!announced) {
              announced = true;
              onFirstAudio?.();
            }

            this.appendCues(analyser.push(pcm), this.lastOriginSec);
          }
        }

        if (done) break;
      }

      // ⚠️ 串流結束一定要 flush。最後不到一幀的尾巴常常正好是句尾的收音，
      // 少了它嘴會停在張開的狀態上——一句話講完嘴不閉，比對不準還明顯。
      this.appendCues(analyser.flush(), this.lastOriginSec);
    } finally {
      reader.cancel().catch(() => {});
      if (generation === this.generation) this.playing = false;
    }
  }

  /**
   * 現在該是哪個嘴型。用 `AudioContext.currentTime` 查表——
   * 那是喇叭的時鐘，不是 `performance.now()`；兩者會漂移，用錯的那個嘴就會慢慢跑掉。
   */
  currentViseme(): VisemeState {
    const ctx = this.ctx;
    const cues = this.timeline;
    if (!ctx || cues.length === 0) return SILENT;

    const now = ctx.currentTime;
    // 還沒開始（第一塊排在 LEAD 之後）
    if (now < cues[0].atSec) return SILENT;

    // 二分搜尋出「最後一個 atSec <= now」的格子。
    // 一段 20 秒的話約 500 格，每次 9 次比較，rAF 每幀跑一次完全不心疼；
    // 用游標快取反而要處理 stop/重播的重置，不划算。
    let lo = 0;
    let hi = cues.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cues[mid].atSec <= now) lo = mid;
      else hi = mid - 1;
    }
    const cue = cues[lo];

    /**
     * 🔴 每一格只在**自己那一幀之內**有效，過了就當作沒有聲音。
     *
     * 原本這裡是拿「整條時間軸的最後一格」判斷講完了沒。那漏掉了中間的洞：
     * 讀取卡住 5 秒時，時間軸上 0.18 秒到 5.08 秒之間一格都沒有，但二分搜尋
     * 仍然會找到斷流前的最後一格，於是**嘴張著凍住 5 秒**才動。
     * 那跟「一句話講完嘴不閉起來」是同一類的瑕疵，而且更明顯，因為它發生在
     * 網路不順的時候——正是使用者本來就在盯著畫面等的時候。
     *
     * 改成逐格判斷之後，句尾的收束也一併涵蓋了，不需要另外一條結束檢查。
     *
     * ⚠️ 加 2ms 容差：`atMs` 是四捨五入到整數毫秒的，每格最多有 0.5ms 誤差，
     * 沒有容差的話連續的格子之間會出現一瞬間的假空隙，嘴會抽動。
     */
    if (now >= cue.atSec + this.frameSec + 0.002) return SILENT;

    return { viseme: cue.viseme, level: cue.level };
  }

  /** 停掉所有已排程的 source、清空時間軸。可以在 `play()` 進行中呼叫。 */
  stop(): void {
    this.generation++;
    this.playing = false;
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // 還沒 start 的 source stop() 會丟 InvalidStateError。
        // 我們排程時一律立刻 start()，理論上不會走到，但不值得為它讓 stop() 失敗。
      }
      source.disconnect();
    }
    this.resetPlaybackState();
  }

  /**
   * 收掉 `AudioContext`。元件卸載時呼叫。
   *
   * ⚠️ 不呼叫的話 context 會留著佔硬體音訊資源；Chrome 對同一個分頁的
   * AudioContext 數量有上限（約 6 個），反覆進出這一頁就會開不出新的。
   */
  dispose(): void {
    this.stop();
    const el = this.audioEl;
    this.audioEl = null;
    this.mediaDest = null;
    if (el) {
      el.pause();
      el.srcObject = null;
    }
    const ctx = this.ctx;
    this.ctx = null;
    ctx?.close().catch(() => {});
  }

  // ── 內部 ────────────────────────────────────────────────

  private ensureContext(): AudioContext {
    if (this.ctx && this.ctx.state !== "closed") return this.ctx;

    // Safari 到現在還只認 webkit 前綴。型別上 window 沒有這個欄位，所以要繞一下。
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error("這個瀏覽器沒有 Web Audio，無法播放裸 PCM。");

    // 直接把 context 開在 24 kHz，讓每一塊 buffer 都不用被重取樣。
    // ⚠️ 有些裝置不接受非硬體取樣率會丟 NotSupportedError，那就退回預設值——
    // 這時候 buffer 仍然標 24000，由瀏覽器自己重取樣，聲音一樣對。
    try {
      this.ctx = new Ctor({ sampleRate: SAMPLE_RATE });
    } catch {
      this.ctx = new Ctor();
    }

    // 🔴 只有 iOS 的輸出改走 <audio> 元素；其他裝置不建，mediaDest 維持 null、直接接 destination。
    // 理由（含 2026-09-30 桌面盲聽）見 `mediaDest` 欄位的註解。iOS 上兩個能力缺一也不做。
    if (
      shouldRouteThroughMediaElement(readMediaRouteEnv()) &&
      typeof this.ctx.createMediaStreamDestination === "function" &&
      typeof Audio !== "undefined"
    ) {
      try {
        const dest = this.ctx.createMediaStreamDestination();
        const el = new Audio();
        el.srcObject = dest.stream;
        el.autoplay = true;
        // iOS：不要進全螢幕播放器。對純音訊元素沒有實際作用，但也沒有副作用
        (el as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
        this.mediaDest = dest;
        this.audioEl = el;
      } catch {
        this.mediaDest = null;
        this.audioEl = null;
      }
    }
    return this.ctx;
  }

  /**
   * 把這塊 PCM 排進播放圖，回傳它實際開始的 context 時間。
   *
   * 游標 `nextAt` 保證遞增：正常情況下一塊接一塊完全沒有縫；只有在讀取慢到
   * 追不上播放（underrun）時才會被 `currentTime + LEAD` 推開。
   */
  private schedule(ctx: AudioContext, pcm: Uint8Array): number {
    const sampleCount = pcm.byteLength / BYTES_PER_SAMPLE;
    const buffer = ctx.createBuffer(1, sampleCount, SAMPLE_RATE);
    const channel = buffer.getChannelData(0);

    // ⚠️ 一定要帶 byteOffset。`value` 常常是 subarray 切出來的視窗，
    // 它的 `buffer` 是整塊原始緩衝——不帶 offset 就會從別人的資料開始讀。
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let i = 0; i < sampleCount; i++) {
      channel[i] = view.getInt16(i * BYTES_PER_SAMPLE, true) / INT16_FULL_SCALE;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // 只有 iOS 有 mediaDest（走 <audio> 才有聲音）；其他裝置是 null，直接接喇叭——理由見欄位註解
    source.connect(this.mediaDest ?? ctx.destination);

    const startedAt = Math.max(ctx.currentTime + this.leadSeconds, this.nextAt);
    source.start(startedAt);
    this.nextAt = startedAt + buffer.duration;

    // 播完就從清單移除，長回答才不會累積上百個死節點
    this.sources.push(source);
    source.onended = () => {
      source.disconnect();
      const at = this.sources.indexOf(source);
      if (at >= 0) this.sources.splice(at, 1);
    };

    return startedAt;
  }

  /** 分析器吐出來的幀（相對整段話開頭的 ms）→ 播放時鐘上的絕對秒數 */
  private appendCues(frames: { atMs: number; viseme: Viseme; level: number }[], originSec: number): void {
    for (const frame of frames) {
      this.timeline.push({
        atSec: originSec + frame.atMs / 1000,
        viseme: frame.viseme,
        level: frame.level,
      });
    }
  }

  /**
   * 補上上一塊留下的半個取樣，回傳偶數長度的視窗；新的半個取樣存起來。
   *
   * ⚠️ 音訊與分析器**必須吃同一份**對齊後的資料。`LipSyncAnalyser` 自己也留
   * remainder，但如果餵它奇數長度的塊，它的 remainder 會是奇數長度，
   * 下一次串接就整個錯位——那個錯位只會表現成「嘴型怪怪的」，很難查。
   */
  private takeSampleAligned(chunk: Uint8Array): Uint8Array {
    if (this.tail.byteLength === 0) {
      const usable = chunk.byteLength - (chunk.byteLength % BYTES_PER_SAMPLE);
      if (usable === chunk.byteLength) return chunk;
      // ⚠️ 尾巴要 copy 不能 subarray：chunk 這一輪之後就沒人持有了
      this.tail = chunk.slice(usable);
      return chunk.subarray(0, usable);
    }

    const merged = new Uint8Array(this.tail.byteLength + chunk.byteLength);
    merged.set(this.tail, 0);
    merged.set(chunk, this.tail.byteLength);
    const usable = merged.byteLength - (merged.byteLength % BYTES_PER_SAMPLE);
    this.tail = merged.slice(usable);
    return merged.subarray(0, usable);
  }

  private resetPlaybackState(): void {
    this.timeline = [];
    this.sources = [];
    this.nextAt = 0;
    this.lastOriginSec = 0;
    this.tail = new Uint8Array(0);
    this.analyser?.reset();
    this.analyser = null;
  }
}
