import { chunksToWav } from "./wav";

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
 * 開始收音之後，等第一塊音訊最多這麼久。
 *
 * worklet 每 4096 個取樣送一塊，48kHz 下約 85ms，正常情況遠遠不到。
 * 等不到就代表 AudioContext 根本沒在 render——與其讓使用者對著一個死掉的
 * 錄音管線講完三秒才發現，不如當場失敗、當場說。
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

function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof AudioContext !== "undefined"
  );
}

export function createRecorder(
  onAutoStop?: () => void,
  /** 錄音期間持續回報音量（0~1）。讓 UI 可以顯示「我聽到你了」。 */
  onLevel?: (rms: number) => void
): Recorder {
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let chunks: Float32Array[] = [];
  let peak = 0;
  let sampleRate = 48_000;
  let active = false;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  /** 這一次按下去的時間。用來分辨「點太快」與「按住了但管線沒在跑」。 */
  let startedAt = 0;
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

  function clearCap() {
    if (capTimer !== null) {
      clearTimeout(capTimer);
      capTimer = null;
    }
  }

  /**
   * ⚠️ 防護三：一定要明確 stop() 每一條 track。
   * 只丟掉 MediaStream 的參照不會關掉麥克風，瀏覽器的錄音指示燈會一直亮著。
   */
  function teardown() {
    clearCap();
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    node?.port.close();
    node?.disconnect();
    node = null;
    source?.disconnect();
    source = null;
    active = false;

    // ⚠️ **不要**在這裡關掉 AudioContext。
    //
    // 曾經改成「每次用完就關、下次重開」，想解決睡眠喚醒之後 context 變殭屍的問題。
    // 但重建一定發生在 `await getUserMedia` **之後**，那時已經離開使用者手勢的窗口，
    // 而沒有手勢的 `AudioContext.resume()` 會**永遠不 resolve**
    //（實測：state 停在 suspended、currentTime 完全不前進、process() 一次都不會被呼叫）。
    // 那個修法本身會製造它想解決的症狀。
    //
    // 現在的作法：重用 context，但在 buildGraph() 裡確認它**真的收得到音訊**，
    // 收不到才回收重建。判斷用事實（第一塊有沒有進來），不用猜的。
  }

  async function doStart(): Promise<void> {
    if (!isSupported()) throw new MicrophoneError("unsupported");

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
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new MicrophoneError("denied", error);
      }
      throw new MicrophoneError("unavailable", error);
    }

    // 見防護一：這期間使用者已經放開了，收到的 stream 必須立刻關掉
    if (abortPending) {
      captured.getTracks().forEach((track) => track.stop());
      return;
    }

    stream = captured;

    // ⚠️ 接好之後要**確認真的收得到音訊**才算成功。第一次收不到就把 context 丟掉
    // 重建一次，再收不到就當場報錯——不要讓使用者對著死掉的管線講完三秒才發現。
    if (!(await buildGraph())) {
      console.warn("[recorder] 收不到音訊，回收 AudioContext 重建一次");
      teardown();
      const dead = context;
      context = null;
      void dead?.close().catch(() => {});
      if (abortPending) return;
      if (!(await buildGraph())) {
        teardown();
        throw new MicrophoneError("unavailable");
      }
    }

    if (abortPending) {
      teardown();
      return;
    }

    startedAt = Date.now();
    active = true;

    // 按住不放的保險。伺服器那邊也有 30 秒上限，這裡先收手是為了不要白錄。
    clearCap();
    capTimer = setTimeout(() => {
      capTimer = null;
      if (active) onAutoStop?.();
    }, MAX_RECORDING_SECONDS * 1000);
  }

  /**
   * 建 AudioContext ＋ 掛 worklet ＋ 接上音訊圖，並等第一塊音訊進來。
   * 回傳「這條管線活著嗎」。
   */
  async function buildGraph(): Promise<boolean> {
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
        console.warn("[recorder] AudioContext.resume() 逾時——多半是沒有使用者手勢");
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

    chunks = [];
    peak = 0;

    let announceFirst: (() => void) | null = null;
    const gotFirst = new Promise<boolean>((resolve) => {
      announceFirst = () => resolve(true);
      setTimeout(() => resolve(false), FIRST_CHUNK_TIMEOUT_MS);
    });

    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, "recorder-processor");
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      announceFirst?.();
      announceFirst = null;
      chunks.push(event.data);
      // 順手算這一塊的 RMS：既給 UI 即時顯示，也累積成整段的峰值。
      // 沒有這個數字，「麥克風壞掉」跟「房間很安靜」在畫面上長得一模一樣。
      let sum = 0;
      for (let i = 0; i < event.data.length; i++) sum += event.data[i] * event.data[i];
      const rms = Math.sqrt(sum / event.data.length);
      if (rms > peak) peak = rms;
      onLevel?.(rms);
    };
    // ⚠️ 不要接到 destination——那會把訪客自己的聲音播回喇叭，形成回授。
    // AudioWorkletNode 不接輸出也照樣會收到 process() 呼叫。
    source.connect(node);

    return gotFirst;
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
        return { kind: "aborted" };
      }

      const captured = chunks;
      const rate = sampleRate;
      const capturedPeak = peak;
      const heldMs = Date.now() - startedAt;
      teardown();
      chunks = [];
      onLevel?.(0);

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

      if (verdict === "no-audio") {
        console.error(
          `[recorder] 按住了 ${heldMs}ms 卻一塊音訊都沒收到——` +
            "AudioContext 或 AudioWorklet 沒在跑（睡眠喚醒／換音訊裝置／被別的分頁佔用）"
        );
        return { kind: "no-audio", heldMs };
      }
      if (verdict === "too-short") return { kind: "too-short", seconds };

      return { kind: "ok", wav: chunksToWav(captured, rate), peak: capturedPeak, seconds };
    },

    async dispose() {
      abortPending = true;
      if (starting) await starting.catch(() => {});
      // teardown() 已經把 context 關掉了，這裡不用再關一次
      teardown();
      chunks = [];
    },
  };
}
