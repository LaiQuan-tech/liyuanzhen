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
 * ## ⚠️ 為什麼不用 `<audio>` 或 `decodeAudioData`
 *
 * `/api/tts` 回的是**裸 PCM**（16-bit LE / 24 kHz / mono，沒有 RIFF 檔頭，
 * 見 `lib/voice/pcm.ts` 的檔頭）。`<audio>` 與 `decodeAudioData` 都要靠容器格式
 * 判斷取樣率與位元深度，餵裸 PCM 進去一律解不出來。所以走
 * `createBuffer` ＋ `AudioBufferSourceNode`，自己把 Int16 轉成 Float32。
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
    source.connect(ctx.destination);

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
