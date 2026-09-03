import { trace } from "@/lib/trace";

/**
 * 按住說話的錄音器。瀏覽器端。
 *
 * 🔴 **2026-08-20 整支重寫。** 原本走 AudioWorklet ＋ 自己編 WAV，
 * 理由寫著「Gemini 接受的音訊格式沒有 webm，所以不能用 MediaRecorder」。
 * **那個前提是錯的。** 實測 gemini-3.5-flash（同一支正式站在用的模型）：
 *
 *   ffmpeg 產的 webm/opus ………………………… 200，逐字稿正確
 *   Chrome 式 webm（標頭沒有總長度）………… 200，逐字稿正確
 *   ogg/opus ……………………………………………… 200，逐字稿正確
 *   Safari 的 mp4/aac ………………………………… 200，逐字稿正確
 *
 * 那個錯誤前提換來的是一條 435 行、跨 AudioContext ／ AudioWorklet ／
 * 自動播放政策三個地雷區的管線，而「按住說話沒反應」修了五輪都在那條路上：
 * context 停在 suspended、resume() 永遠不 resolve、worklet 一塊都不送、
 * 第一塊音訊逾時、重接的死碼、start() 被擋住 700ms。
 * 那些失敗模式**在 MediaRecorder 上全部不存在**。
 *
 * 現在的做法跟 Sunny 展場 kiosk 一致（app/kiosk/page.tsx），那一版一直是好的。
 *
 * ⚠️ AudioContext 沒有完全消失——音量計還需要一個 AnalyserNode。
 * 但它現在只在「畫音量」這條路上，**不在錄音的路上**：
 * 它整個掛掉，訪客失去的只是一排會跳的柱子，話照樣錄得到、送得出去。
 * 這個分界是這次重寫的重點，不要為了讓音量計更準而把它移回關鍵路徑。
 */

/**
 * 錄音上限。到點自動收手（`onAutoStop` → LiveStage 的 `release()`），
 * 避免無上限地吃額度。
 *
 * 🔴 2026-09-03 從 30 秒改成 45 秒，因為互動從「按住說話」改成「點一下切換」。
 * 按住式有人的手當上限——手一放就結束了；切換式允許「按了就走開」，
 * 這個計時器從次要的保險變成**唯一**的收手機制。45 秒對「講一個問題」夠用。
 *
 * ⚠️ 改這個數字要同時看三個地方，少一個就會壞：
 *   1. `app/api/stt/route.ts` 的 `MAX_AUDIO_BYTES`——Safari 的 AAC 不理
 *      `audioBitsPerSecond`（那是建議不是保證），實測 64~128kbps，
 *      45 秒最壞情況約 720KB。上限沒跟著調，iPhone 的長問題會吃 413，
 *      而畫面上只看得到「失敗」，看不出原因。
 *   2. `components/avatar/AvatarStage.tsx` 的 `IDLE_MS`（75 秒）——錄音期間
 *      沒有任何 reportActivity 的話，計費中的 session 會在訪客講話時被收掉。
 *      LiveStage 因此在錄音期間節流呼叫 `reportActivity()`。
 *   3. `content/site.ts` 的 `recordingNearCap` 文案（裡面寫著秒數）。
 */
export const MAX_RECORDING_SECONDS = 45;

/** 太短的一律當成誤觸。0.2 秒以下連一個字都講不完。 */
export const MIN_RECORDING_SECONDS = 0.2;

/**
 * 壓縮位元率。24kbps 的 opus 對語音辨識綽綽有餘，45 秒約 135KB。
 *
 * ⚠️ 這個數字同時決定伺服器那邊的位元組上限（見 app/api/stt/route.ts），
 * 兩邊要一起改。調高的話上限也要跟著調，否則正常長度的錄音會被 413 擋掉。
 */
const AUDIO_BITS_PER_SECOND = 24_000;

/**
 * 想要的容器，依序試。
 *
 * ⚠️ 不要寫死一個。Chrome 給 webm/opus、Safari 給 mp4/aac、Firefox 給 ogg/opus，
 * 三種 Gemini 都收（見檔頭實測）。真正送出去的 Content-Type 一律讀
 * `recorder.mimeType`——瀏覽器最後選了什麼只有它自己知道，不要用猜的。
 */
const PREFERRED_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

export type MicrophoneFailure =
  /** 使用者按了「封鎖」，或瀏覽器設定擋掉了 */
  | "denied"
  /** 沒有可用的輸入裝置 */
  | "unavailable"
  /** 這個瀏覽器沒有 getUserMedia 或 MediaRecorder */
  | "unsupported";

export class MicrophoneError extends Error {
  constructor(readonly reason: MicrophoneFailure, cause?: unknown) {
    super(`麥克風無法使用：${reason}`);
    this.name = "MicrophoneError";
    this.cause = cause;
  }
}

/**
 * 低於這個 RMS 才算「麥克風根本沒在收音」。
 *
 * ⚠️ 這個數字**只用來抓真正的數位靜音**（麥克風被靜音、選到不存在的裝置），
 * 不是用來判斷「講得夠不夠大聲」。不要調高。
 *
 * 實測（Chrome ＋ 真實麥克風，2026-08-19）：
 *   安靜房間、沒有人說話 …… 峰值 0.00706
 *   使用者正常說話 …………… 每秒 RMS 約 0.009 ~ 0.019
 *
 * 兩者只差一個數量級不到。第一版把門檻設成 0.01，結果**擋掉了真的語音**——
 * 使用者按住、講完、放開，得到「沒有收到聲音」。那比沉默更糟，
 * 因為它還指著錯的方向叫他去檢查麥克風。低音量交給 Gemini 處理，它做得比門檻好。
 */
export const SILENCE_RMS = 0.001;

/**
 * 一段錄音只有標頭、沒有內容時的位元組上限。
 *
 * Chrome 的 webm 標頭約 200~400 bytes；24kbps 之下光是 0.3 秒也有 900 bytes。
 * 所以低於這個數字就是真的什麼都沒錄到。
 */
const EMPTY_AUDIO_BYTES = 800;

/** 按住超過這麼久卻什麼都沒錄到，就不是誤觸，是收音壞了。 */
const NO_AUDIO_HOLD_MS = 500;

export interface RecordingResult {
  blob: Blob;
  /** 送去 /api/stt 的 Content-Type。⚠️ 一定要用這個，不要自己猜容器。 */
  mimeType: string;
  seconds: number;
  /**
   * 整段的音量峰值。
   *
   * 🔴 **null 不是 0，是「不知道」。** 音量計要 AudioContext，而它有可能
   * 被自動播放政策擋住而永遠停在 suspended——那種時候讀到的一律是 0。
   * 把「不知道」當成「靜音」，訪客明明講了話卻會被回「沒有收到聲音」。
   * 呼叫端看到 null 必須**放行**。
   */
  peak: number | null;
}

/**
 * 判斷這一次錄音該算成哪一種結局。純函式，所以測得到。
 *
 * ⚠️ 三種情況要分開，這裡是「按住沒反應」誤導的核心：
 *   點一下就放（幾乎沒有位元組、按住很短）…………… too-short，安靜帶過
 *   按住講了一秒卻什麼都沒錄到 ／ 音軌是 muted ……… no-audio，要講清楚
 *   有錄到但不足 0.2 秒 …………………………………………… too-short
 *
 * `trackMuted` 是 MediaRecorder 這條路才有的好東西：`MediaStreamTrack.muted`
 * 的語意就是「這條軌現在沒有在提供資料」，比任何自己算的門檻都準。
 */
export function classifyRecording(input: {
  bytes: number;
  heldMs: number;
  seconds: number;
  trackMuted: boolean;
}): "ok" | "too-short" | "no-audio" {
  if (input.trackMuted) return "no-audio";
  if (input.bytes <= EMPTY_AUDIO_BYTES) {
    return input.heldMs >= NO_AUDIO_HOLD_MS ? "no-audio" : "too-short";
  }
  return input.seconds < MIN_RECORDING_SECONDS ? "too-short" : "ok";
}

export type RecordingOutcome =
  | ({ kind: "ok" } & RecordingResult)
  /** 誤觸。太短，安靜帶過就好 */
  | { kind: "too-short"; seconds: number }
  /** 按住夠久卻什麼都沒錄到 */
  | { kind: "no-audio"; heldMs: number }
  /** getUserMedia 還沒 resolve 就放開了 */
  | { kind: "aborted" };

export interface Recorder {
  readonly recording: boolean;
  /** ⚠️ 必須在使用者手勢的呼叫堆疊裡呼叫。失敗時丟 MicrophoneError。 */
  start(): Promise<void>;
  /** 停止並回傳結局。四種結局要分開，見 RecordingOutcome。 */
  stop(): Promise<RecordingOutcome>;
  /** 釋放所有資源。冪等。 */
  dispose(): Promise<void>;
}

export interface RecorderHooks {
  /** 撞到錄音上限（MAX_RECORDING_SECONDS），自動收手 */
  onAutoStop?: () => void;
  /** 錄音期間持續回報音量（0~1）。純視覺，不參與任何判斷。 */
  onLevel?: (rms: number) => void;
}

function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined"
  );
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return PREFERRED_TYPES.find((type) => {
    try {
      return MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  });
}

/** 音量計的取樣間隔。85ms 是為了跟 level.ts 的 LEVEL_DECAY=0.9 對齊。 */
const METER_INTERVAL_MS = 85;

export function createRecorder(hooks: RecorderHooks = {}): Recorder {
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let active = false;
  let startedAt = 0;
  let capTimer: ReturnType<typeof setTimeout> | null = null;

  /** 音量計。⚠️ 全部是 best-effort，這一段的任何失敗都不可以影響錄音。 */
  let meterContext: AudioContext | null = null;
  let meterTimer: ReturnType<typeof setInterval> | null = null;
  let peak = 0;

  /**
   * ⚠️ 防護一：使用者點超快，`pointerup` 在 `getUserMedia` 還沒 resolve 就到了。
   * 沒有這道旗標，那個稍後才拿到的 stream 會變成孤兒——**麥克風一直開著**，
   * 分頁的錄音紅點也一直亮著，而畫面上看起來一切正常。
   */
  let abortPending = false;

  /** ⚠️ 防護二：start() 還在跑的時候再按一次，不可以開出第二條音軌。 */
  let starting: Promise<void> | null = null;

  function stopMeter() {
    if (meterTimer !== null) {
      clearInterval(meterTimer);
      meterTimer = null;
    }
  }

  /**
   * 音量計。**整段包在 try 裡，而且不 await 任何東西。**
   *
   * 🔴 這是這次重寫最重要的一條界線。舊版的 AudioContext 在錄音的關鍵路徑上，
   * 於是「自動播放政策讓 context 停在 suspended」這種跟收音完全無關的事
   * 會讓整段話錄不到。現在它掛掉的代價只有「柱子不會動」。
   *
   * ⚠️ `resume()` 不可以 await——沒有使用者手勢時它永遠不會 resolve。
   */
  function startMeter(source: MediaStream) {
    try {
      const ctx = new AudioContext();
      meterContext = ctx;
      void ctx.resume().catch(() => {});
      const node = ctx.createMediaStreamSource(source);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      node.connect(analyser);

      const buffer = new Float32Array(analyser.fftSize);
      meterTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
        const rms = Math.sqrt(sum / buffer.length);
        if (rms > peak) peak = rms;
        hooks.onLevel?.(rms);
      }, METER_INTERVAL_MS);
    } catch (error) {
      trace("音量計開不起來（不影響錄音）", String(error), "warn");
    }
  }

  /**
   * ⚠️ 防護三：一定要明確 stop() 每一條 track。
   * 只丟掉 MediaStream 的參照不會關掉麥克風，瀏覽器的錄音指示燈會一直亮著。
   */
  function teardown() {
    if (capTimer !== null) {
      clearTimeout(capTimer);
      capTimer = null;
    }
    stopMeter();
    const ctx = meterContext;
    meterContext = null;
    void ctx?.close().catch(() => {});
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    recorder = null;
    active = false;
  }

  async function doStart(): Promise<void> {
    if (!isSupported()) throw new MicrophoneError("unsupported");

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

    const mimeType = pickMimeType();
    try {
      recorder = new MediaRecorder(
        captured,
        mimeType
          ? { mimeType, audioBitsPerSecond: AUDIO_BITS_PER_SECOND }
          : { audioBitsPerSecond: AUDIO_BITS_PER_SECOND }
      );
    } catch (error) {
      teardown();
      trace("MediaRecorder 建不起來", String(error), "error");
      throw new MicrophoneError("unavailable", error);
    }

    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    recorder.start();

    startedAt = pressedAt;
    active = true;
    startMeter(captured);
    trace("開始錄音", `${recorder.mimeType}、${Date.now() - pressedAt}ms`);

    // 忘記按第二下的保險。伺服器那邊也有上限，這裡先收手是為了不要白錄。
    capTimer = setTimeout(() => {
      capTimer = null;
      if (active) hooks.onAutoStop?.();
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

    async stop(): Promise<RecordingOutcome> {
      // 見防護一：start() 還沒 resolve 就放開了
      if (starting) {
        abortPending = true;
        await starting.catch(() => {});
      }
      const current = recorder;
      if (!active || !current) {
        teardown();
        trace("放開時錄音還沒開始", "aborted", "warn");
        return { kind: "aborted" };
      }

      const heldMs = Date.now() - startedAt;
      const track = stream?.getAudioTracks()[0];
      // ⚠️ 要在 teardown() **之前**讀。track.stop() 之後 muted 就沒有意義了。
      const trackMuted = Boolean(track?.muted) || track?.readyState === "ended";

      // 音量計的可信度：context 沒有真的跑起來時讀到的一律是 0，
      // 那是「不知道」不是「靜音」。見 RecordingResult.peak。
      const meterRan = meterContext?.state === "running";
      stopMeter();

      const blob = await new Promise<Blob>((resolve) => {
        const type = current.mimeType || "audio/webm";
        current.onstop = () => resolve(new Blob(chunks, { type }));
        try {
          current.stop();
        } catch {
          // 已經停了。用手上有的塊組起來就好。
          resolve(new Blob(chunks, { type }));
        }
      });

      const mimeType = current.mimeType || blob.type || "audio/webm";
      teardown();
      chunks = [];
      hooks.onLevel?.(0);

      const seconds = heldMs / 1000;
      const verdict = classifyRecording({
        bytes: blob.size,
        heldMs,
        seconds,
        trackMuted,
      });
      trace(
        "放開",
        `按住 ${heldMs}ms、${blob.size} bytes、${mimeType}、峰值 ${
          meterRan ? peak.toFixed(4) : "未知"
        } → ${verdict}`,
        verdict === "ok" ? "info" : "warn"
      );

      if (verdict === "no-audio") return { kind: "no-audio", heldMs };
      if (verdict === "too-short") return { kind: "too-short", seconds };

      return {
        kind: "ok",
        blob,
        mimeType,
        seconds,
        peak: meterRan ? peak : null,
      };
    },

    async dispose() {
      abortPending = true;
      if (starting) await starting.catch(() => {});
      try {
        if (recorder && recorder.state !== "inactive") recorder.stop();
      } catch {
        // 收不掉也要繼續把麥克風關掉
      }
      teardown();
      chunks = [];
    },
  };
}
