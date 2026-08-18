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

export interface Recorder {
  readonly recording: boolean;
  /** ⚠️ 必須在使用者手勢的呼叫堆疊裡呼叫。失敗時丟 MicrophoneError。 */
  start(): Promise<void>;
  /** 停止並回傳 WAV。沒錄到東西（太短或空的）回 null。 */
  stop(): Promise<Uint8Array | null>;
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

export function createRecorder(onAutoStop?: () => void): Recorder {
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let chunks: Float32Array[] = [];
  let sampleRate = 48_000;
  let active = false;
  let capTimer: ReturnType<typeof setTimeout> | null = null;

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
    context = context ?? new AudioContext();
    // 自動播放政策可能讓 context 一開始是 suspended
    if (context.state === "suspended") await context.resume();
    sampleRate = context.sampleRate;

    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    if (abortPending) {
      teardown();
      return;
    }

    chunks = [];
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, "recorder-processor");
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      chunks.push(event.data);
    };
    source.connect(node);
    // ⚠️ 不要接到 destination——那會把訪客自己的聲音播回喇叭，形成回授。
    // AudioWorkletNode 不接輸出也照樣會收到 process() 呼叫。
    active = true;

    // 按住不放的保險。伺服器那邊也有 30 秒上限，這裡先收手是為了不要白錄。
    clearCap();
    capTimer = setTimeout(() => {
      capTimer = null;
      if (active) onAutoStop?.();
    }, MAX_RECORDING_SECONDS * 1000);
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

    async stop() {
      // 見防護一：start() 還沒 resolve 就放開了
      if (starting) {
        abortPending = true;
        await starting.catch(() => {});
      }
      if (!active) {
        teardown();
        return null;
      }

      const captured = chunks;
      const rate = sampleRate;
      teardown();
      chunks = [];

      const total = captured.reduce((sum, chunk) => sum + chunk.length, 0);
      if (total / rate < MIN_RECORDING_SECONDS) return null;

      return chunksToWav(captured, rate);
    },

    async dispose() {
      abortPending = true;
      if (starting) await starting.catch(() => {});
      teardown();
      chunks = [];
      if (context) {
        await context.close().catch(() => {});
        context = null;
      }
    },
  };
}
