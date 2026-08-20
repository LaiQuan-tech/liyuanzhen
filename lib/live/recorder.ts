import { chunksToWav } from "./wav";
import { trace } from "@/lib/trace";

/**
 * 按住說話的錄音器。瀏覽器端。
 *
 * ⚠️ 刻意**不用** `MediaRecorder`。它在 Chrome 只吐 `audio/webm;codecs=opus`、
 * Safari 吐 `audio/mp4`，而 Gemini 接受的音訊格式（wav/mp3/aiff/aac/ogg/flac）
 * 兩個都不在裡面。走 Web Audio 自己收 Float32 再編 WAV，就沒有容器相容性問題。
 * 詳見 lib/live/wav.ts 的檔頭。
 *
 * 三道競態防護是照 Sunny 展場版踩過的坑抄的（那邊是 commit 9a41fee 補的），
 * 每一道都對應一個真實症狀，不要因為「看起來多餘」就刪掉——見各自的註解。
 */

/** 跟 /api/stt 的上限一致。按住不放時自動收手，避免無上限地吃記憶體。 */
export const MAX_RECORDING_SECONDS = 30;

/** 太短的一律當成誤觸。0.2 秒以下連一個字都講不完。 */
export const MIN_RECORDING_SECONDS = 0.2;

export type MicrophoneFailure =
  /** 使用者按了「封鎖」，或瀏覽器設定擋掉了 */
  | "denied"
  /** 沒有可用的輸入裝置 */
  | "unavailable"
  /** 這個瀏覽器沒有 getUserMedia 或 AudioWorklet */
  | "unsupported";

export class MicrophoneError extends Error {
  constructor(readonly reason: MicrophoneFailure, cause?: unknown) {
    super(`麥克風無法使用：${reason}`);
    this.name = "MicrophoneError";
    this.cause = cause;
  }
}

/**
 * AudioWorklet 的程式碼。
 *
 * ⚠️ 用 Blob URL 載入而不是放 public/ 下的獨立檔案：
 * 那個檔案跟這裡的邏輯是一體的，分開放很容易改了一邊忘了另一邊，
 * 而且症狀會是「錄音是空的」——離現場很遠。
 *
 * ⚠️ 在 worklet 裡先累積再 post。每個 render quantum 是 128 個取樣，
 * 48kHz 下等於每秒 375 次 postMessage，那個開銷會讓主執行緒抖。
 */
const WORKLET_SOURCE = `
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.offset = 0;
  }
  flush() {
    if (this.offset === 0) return;
    // 一定要 slice：底層的 buffer 會被重複使用，直接送出去會收到被覆寫的內容
    this.port.postMessage(this.buffer.slice(0, this.offset));
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.offset++] = channel[i];
      if (this.offset === this.buffer.length) this.flush();
    }
    return true;
  }
}
registerProcessor("recorder-processor", RecorderProcessor);
`;

/**
 * 低於這個 RMS 才算「麥克風根本沒在收音」。
 *
 * ⚠️ 這個數字**只用來抓真正的數位靜音**（麥克風被靜音、選到不存在的裝置），
 * 不是用來判斷「講得夠不夠大聲」。不要調高。
 *
 * 實測（Chrome + 開啟 echoCancellation/noiseSuppression/autoGainControl 的
 * 真實麥克風，2026-08-19）：
 *   安靜房間、沒有人說話 …… 3 秒內 85ms 窗口峰值 0.00706
 *   使用者正常說話 …………… 每秒 RMS 約 0.009 ~ 0.019
 *
 * 兩者只差一個數量級不到。我第一版把門檻設成 0.01，結果**擋掉了真的語音**——
 * 使用者按住、講完、放開，得到「沒有收到聲音」。那比原本的沉默更糟，
 * 因為它還指著錯的方向叫他去檢查麥克風。
 *
 * 被靜音的麥克風給的是 0 或 1e-8 等級，所以 0.001 就切得乾淨，
 * 而且不會誤傷任何真的有收到東西的情況。低音量交給 Gemini 處理——實測它做得比門檻好。
 */
export const SILENCE_RMS = 0.001;

export interface RecordingResult {
  wav: Uint8Array;
  /** 整段錄音的音量峰值。用來分辨「太安靜」與「說了但辨識不出」 */
  peak: number;
  seconds: number;
}

/**
 * 按住超過這個時間卻連一塊音訊都沒收到，就不是誤觸，是錄音管線壞了。
 *
 * worklet 每 4096 個取樣送一塊，48kHz 下約 85ms。所以 0.5 秒之內收不到塊
 * 還可能只是點太快；超過就一定有問題。
 */
const NO_AUDIO_HOLD_MS = 500;

/**
 * 接上音訊圖之後，等第一塊音訊多久才判定這條管線沒在跑。
 *
 * 🔴 **這個等待不可以擋在 start() 的路徑上。**
 *
 * 前一版把它寫成 `if (!(await buildGraph())) ...`，於是每一次按下說話都要先
 * 賭 700ms 內收得到音訊，收不到就整支 start() 丟 MicrophoneError("unavailable")，
 * 畫面顯示「找不到可用的麥克風」——一句既嚇人又指錯方向的話。
 * 藍牙耳機接上來的頭幾百毫秒本來就沒有取樣，那不是「找不到麥克風」。
 *
 * 現在改成背景看門狗：照常開始錄音，收不到才在**訪客還在講話的時候**提醒他，
 * 而不是先把他擋在門外。真正的判定仍然在放開時由 classifyRecording 做。
 */
const FIRST_CHUNK_TIMEOUT_MS = 700;

/** `context.resume()` 等多久。⚠️ 沒有使用者手勢時它會**永遠不 resolve**，不能裸 await。 */
const RESUME_TIMEOUT_MS = 1_500;

/**
 * 一次錄音的結局。
 *
 * ⚠️ 刻意不是 `RecordingResult | null`。舊版把「誤觸」與「一塊都沒收到」
 * 通通回 null，呼叫端只能一律顯示「按住不放，講完再放開」——
 * 使用者明明按住講了一秒，卻被指責按太快，而真正的問題（麥克風管線死掉）
 * 一個字都沒提到。實際發生過，這個型別就是為了讓它不可能再發生。
 */
/**
 * 判斷這一次錄音該算成哪一種結局。純函式，所以測得到——
 * `stop()` 本身要 AudioContext 與 getUserMedia，在 node 環境跑不起來。
 *
 * ⚠️ 這裡是整個「按住沒反應」誤導的核心。三種情況要分開：
 *   點一下就放（chunkCount 0、按住很短）………… too-short，安靜帶過
 *   按住講了一秒卻零塊（chunkCount 0、按住夠久）… no-audio，管線死了，要講清楚
 *   有收到但取樣不足 0.2 秒 …………………………… too-short
 */
export function classifyRecording(input: {
  chunkCount: number;
  heldMs: number;
  seconds: number;
}): "ok" | "too-short" | "no-audio" {
  if (input.chunkCount === 0) {
    return input.heldMs >= NO_AUDIO_HOLD_MS ? "no-audio" : "too-short";
  }
  return input.seconds < MIN_RECORDING_SECONDS ? "too-short" : "ok";
}

export type RecordingOutcome =
  | ({ kind: "ok" } & RecordingResult)
  /** 誤觸。太短，安靜帶過就好 */
  | { kind: "too-short"; seconds: number }
  /** 按住夠久卻一塊音訊都沒收到——AudioContext 或 worklet 沒在跑 */
  | { kind: "no-audio"; heldMs: number }
  /** getUserMedia 還沒 resolve 就放開了 */
  | { kind: "aborted" };

export interface Recorder {
  readonly recording: boolean;
  /** ⚠️ 必須在使用者手勢的呼叫堆疊裡呼叫。失敗時丟 MicrophoneError。 */
  start(): Promise<void>;
  /**
   * 停止並回傳結局。四種結局要分開，見 RecordingOutcome 的說明。
   *
   * ⚠️ 全靜音**不**算失敗。呼叫端需要分辨「誤觸」「管線死掉」「說了但很小聲」，
   * 最後一種用 peak 判斷，不要在這裡就吞掉。
   */
  stop(): Promise<RecordingOutcome>;
  /** 釋放所有資源。冪等。 */
  dispose(): Promise<void>;
}

export interface RecorderHooks {
  /** 按住撞到 30 秒上限，自動收手 */
  onAutoStop?: () => void;
  /** 錄音期間持續回報音量（0~1）。讓 UI 可以顯示「我聽到你了」。 */
  onLevel?: (rms: number) => void;
  /**
   * 接上音訊圖、重接一次之後仍然一塊音訊都沒有。
   *
   * ⚠️ 這支在**錄音進行中**就會被呼叫，目的是讓訪客不要對著一條死掉的管線
   * 講完三秒才發現。它不中止錄音——真正的判定仍然在放開時做。
   */
  onNoAudio?: () => void;
}

function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof AudioContext !== "undefined"
  );
}

export function createRecorder(hooks: RecorderHooks = {}): Recorder {
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let chunks: Float32Array[] = [];
  let peak = 0;
  let sampleRate = 48_000;
  let active = false;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 這一次**按下去**的時間（不是音訊圖接好的時間）。
   *
   * ⚠️ 要用按下的那一刻。用「接好之後」的話，getUserMedia 花掉的時間就從
   * heldMs 裡消失了，而 classifyRecording 正是靠 heldMs 分辨
   * 「點太快」與「按住了但管線沒在跑」——少算就會把後者誤判成前者。
   */
  let startedAt = 0;
  /** 第一塊音訊進來的時間（距離 startedAt 的毫秒）。0 ＝ 還沒收到。 */
  let firstChunkAt = 0;
  /** 哪些 AudioContext 已經掛過 worklet。同一個 context 掛第二次會撞名。 */
  const moduleLoadedFor = new WeakSet<AudioContext>();

  /**
   * ⚠️ 防護一：使用者點超快，`pointerup` 在 `getUserMedia` 還沒 resolve 就到了。
   * 沒有這道旗標，那個稍後才拿到的 stream 會變成孤兒——**麥克風一直開著**，
   * 分頁的錄音紅點也一直亮著，而畫面上看起來一切正常。
   */
  let abortPending = false;

  /** ⚠️ 防護二：start() 還在跑的時候再按一次，不可以開出第二條音軌。 */
  let starting: Promise<void> | null = null;

  function clearTimers() {
    if (capTimer !== null) {
      clearTimeout(capTimer);
      capTimer = null;
    }
    if (watchTimer !== null) {
      clearTimeout(watchTimer);
      watchTimer = null;
    }
  }

  /**
   * 只拆音訊圖，**保留 stream 與麥克風權限**。
   *
   * 🔴 這支跟 teardown() 分開是為了修一個真的 bug。前一版在「收不到音訊、
   * 回收 AudioContext 重接一次」那條路上呼叫了 teardown()，而 teardown()
   * 會 `stream.getTracks().forEach(stop)` 並把 stream 設成 null——
   * 於是緊接著的重接第一行 `if (!stream) return false` 直接失敗。
   * 那個「重試一次」從來沒有真的執行過，每一次都是丟出
   * MicrophoneError("unavailable")，畫面顯示「找不到可用的麥克風」。
   */
  function releaseGraph() {
    node?.port.close();
    node?.disconnect();
    node = null;
    source?.disconnect();
    source = null;
  }

  /**
   * ⚠️ 防護三：一定要明確 stop() 每一條 track。
   * 只丟掉 MediaStream 的參照不會關掉麥克風，瀏覽器的錄音指示燈會一直亮著。
   */
  function teardown() {
    clearTimers();
    releaseGraph();
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    active = false;

    // ⚠️ **不要**在這裡關掉 AudioContext。
    //
    // 曾經改成「每次用完就關、下次重開」，想解決睡眠喚醒之後 context 變殭屍的問題。
    // 但重建一定發生在 `await getUserMedia` **之後**，那時已經離開使用者手勢的窗口，
    // 而沒有手勢的 `AudioContext.resume()` 會**永遠不 resolve**
    //（實測：state 停在 suspended、currentTime 完全不前進、process() 一次都不會被呼叫）。
    // 那個修法本身會製造它想解決的症狀。
    //
    // 現在的作法：重用 context，由看門狗確認它**真的收得到音訊**，收不到才回收重建。
    // 判斷用事實（第一塊有沒有進來），不用猜的。
  }

  async function doStart(): Promise<void> {
    if (!isSupported()) throw new MicrophoneError("unsupported");

    // ⚠️ 時間原點在這裡，不在音訊圖接好之後。見 startedAt 的說明。
    const pressedAt = Date.now();

    let captured: MediaStream;
    try {
      captured = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      const name = (error as DOMException)?.name;
      trace("麥克風被拒絕", name ?? "未知錯誤", "error");
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new MicrophoneError("denied", error);
      }
      throw new MicrophoneError("unavailable", error);
    }
    trace("拿到麥克風", `${Date.now() - pressedAt}ms`);

    // 見防護一：這期間使用者已經放開了，收到的 stream 必須立刻關掉
    if (abortPending) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }

    stream = captured;
    chunks = [];
    peak = 0;
    firstChunkAt = 0;

    if (!(await connectGraph())) {
      teardown();
      throw new MicrophoneError("unavailable");
    }

    if (abortPending) {
      teardown();
      return;
    }

    startedAt = pressedAt;
    active = true;
    trace("開始錄音", `${Date.now() - pressedAt}ms`);

    // 按住不放的保險。伺服器那邊也有 30 秒上限，這裡先收手是為了不要白錄。
    clearTimers();
    capTimer = setTimeout(() => {
      capTimer = null;
      if (active) hooks.onAutoStop?.();
    }, MAX_RECORDING_SECONDS * 1000);

    armWatchdog();
  }

  /**
   * 收不到音訊時的背景看門狗。
   *
   * ⚠️ 它**不擋**錄音，只在確定收不到之後提醒訪客。理由見 FIRST_CHUNK_TIMEOUT_MS。
   * 重接那一次只拆音訊圖（releaseGraph）不動 stream，否則重接必定失敗。
   */
  function armWatchdog() {
    watchTimer = setTimeout(() => {
      watchTimer = null;
      if (!active || firstChunkAt) return;

      trace("第一塊音訊逾時，回收 AudioContext 重接", `${FIRST_CHUNK_TIMEOUT_MS}ms`, "warn");
      releaseGraph();
      const stale = context;
      context = null;
      void stale?.close().catch(() => {});

      void (async () => {
        if (!active || !(await connectGraph())) {
          if (active) {
            trace("重接失敗，這條錄音管線是死的", undefined, "error");
            hooks.onNoAudio?.();
          }
          return;
        }
        watchTimer = setTimeout(() => {
          watchTimer = null;
          if (!active || firstChunkAt) return;
          trace("重接之後仍然收不到音訊", undefined, "error");
          hooks.onNoAudio?.();
        }, FIRST_CHUNK_TIMEOUT_MS);
      })();
    }, FIRST_CHUNK_TIMEOUT_MS);
  }

  /**
   * 建（或重用）AudioContext ＋ 掛 worklet ＋ 接上音訊圖。
   * 回傳「有沒有接起來」——注意這**不代表**收得到音訊，那是看門狗的事。
   */
  async function connectGraph(): Promise<boolean> {
    if (!stream) return false;
    context = context ?? new AudioContext();

    if (context.state === "suspended") {
      // ⚠️ 不可以裸 await：沒有使用者手勢時它永遠不會 resolve，start() 會整個卡住，
      // 症狀是按下去按鈕永遠不變成「放開送出」。
      const ctx = context;
      const resumed = await Promise.race([
        ctx.resume().then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), RESUME_TIMEOUT_MS)),
      ]);
      if (!resumed) {
        trace("AudioContext.resume() 逾時", "多半是沒有使用者手勢", "error");
        return false;
      }
    }
    sampleRate = context.sampleRate;

    if (!moduleLoadedFor.has(context)) {
      // ⚠️ 同一個 context 上重複 addModule 會讓 registerProcessor 撞名而 reject，
      // 所以每個 context 只掛一次。
      const url = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: "application/javascript" })
      );
      try {
        await context.audioWorklet.addModule(url);
        moduleLoadedFor.add(context);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    if (abortPending) return false;

    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, "recorder-processor");
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!firstChunkAt) {
        firstChunkAt = Date.now() - (startedAt || Date.now());
        trace("第一塊音訊", `${firstChunkAt}ms`);
      }
      chunks.push(event.data);
      // 順手算這一塊的 RMS：既給 UI 即時顯示，也累積成整段的峰值。
      // 沒有這個數字，「麥克風壞掉」跟「房間很安靜」在畫面上長得一模一樣。
      let sum = 0;
      for (let i = 0; i < event.data.length; i++) sum += event.data[i] * event.data[i];
      const rms = Math.sqrt(sum / event.data.length);
      if (rms > peak) peak = rms;
      hooks.onLevel?.(rms);
    };
    // ⚠️ 不要接到 destination——那會把訪客自己的聲音播回喇叭，形成回授。
    // AudioWorkletNode 不接輸出也照樣會收到 process() 呼叫。
    source.connect(node);

    return true;
  }

  return {
    get recording() {
      return active;
    },

    async start() {
      if (active || starting) return;
      abortPending = false;
      starting = doStart().finally(() => {
        starting = null;
      });
      await starting;
    },

    async stop(): Promise<RecordingOutcome> {
      // 見防護一：start() 還沒 resolve 就放開了
      if (starting) {
        abortPending = true;
        await starting.catch(() => {});
      }
      if (!active) {
        teardown();
        trace("放開時錄音還沒開始", "aborted", "warn");
        return { kind: "aborted" };
      }

      const captured = chunks;
      const rate = sampleRate;
      const capturedPeak = peak;
      const heldMs = Date.now() - startedAt;
      teardown();
      chunks = [];
      hooks.onLevel?.(0);

      // ⚠️ 一塊都沒收到，而且按住夠久 → 是錄音管線死掉，不是誤觸。
      // 這兩件事對使用者的意義完全相反：一個要他再按一次，
      // 另一個要他重新整理。舊版把它們塌成同一句，害人找錯方向。
      const total = captured.reduce((sum, chunk) => sum + chunk.length, 0);
      const seconds = total / rate;
      const verdict = classifyRecording({
        chunkCount: captured.length,
        heldMs,
        seconds,
      });
      trace(
        "放開",
        `按住 ${heldMs}ms、${captured.length} 塊、${seconds.toFixed(2)}s、峰值 ${capturedPeak.toFixed(4)} → ${verdict}`,
        verdict === "ok" ? "info" : "warn"
      );

      if (verdict === "no-audio") return { kind: "no-audio", heldMs };
      if (verdict === "too-short") return { kind: "too-short", seconds };

      return { kind: "ok", wav: chunksToWav(captured, rate), peak: capturedPeak, seconds };
    },

    async dispose() {
      abortPending = true;
      if (starting) await starting.catch(() => {});
      teardown();
      chunks = [];
    },
  };
}
