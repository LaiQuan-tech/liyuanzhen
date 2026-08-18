/**
 * 把麥克風錄到的音訊編成 WAV。純函式、無 IO、不碰任何瀏覽器 API，
 * 所以能在 vitest（`environment: "node"`）裡完整測試——這個 repo 沒有 jsdom
 * 也沒有元件測試，把邏輯留在純函式裡是唯一驗得到的路。
 *
 * ⚠️ 不要跟 `lib/voice/pcm.ts` 搞混，兩者的規則正好相反：
 *
 *   輸出（她講話）：LiveAvatar 要**裸 PCM**，24kHz。加了 WAV 標頭 → 每塊開頭爆音。
 *   輸入（訪客講話）：Gemini 要**有容器的音訊**，16kHz 就夠。送裸 PCM → 它不知道取樣率。
 *
 * 為什麼是 WAV 而不是直接把 MediaRecorder 的輸出丟上去：
 * Gemini 接受 wav / mp3 / aiff / aac / ogg / flac，**沒有 webm**。
 * 而 MediaRecorder 在 Chrome 只吐 `audio/webm;codecs=opus`、Safari 吐 `audio/mp4`。
 * 自己編 WAV 就沒有容器格式的相容性問題，代價只是檔案大一點
 * （16kHz 單聲道 16-bit ＝ 32KB/秒，10 秒的問題約 320KB）。
 */

/** STT 的標準取樣率。再高對辨識沒有幫助，只是讓上傳變慢。 */
export const TARGET_SAMPLE_RATE = 16_000;
/** 16-bit ＝ 每個取樣 2 bytes */
export const BYTES_PER_SAMPLE = 2;
/** RIFF ＋ fmt ＋ data 三個 chunk 的標頭合計 */
export const WAV_HEADER_BYTES = 44;

export interface Downsampled {
  samples: Float32Array;
  /** 這批資料**實際**的取樣率，不一定等於 TARGET_SAMPLE_RATE——見下方說明 */
  sampleRate: number;
}

/**
 * 降到 16kHz。用區間平均而不是直接抽樣：
 * 直接抽樣會產生 aliasing，把高頻摺回可聽範圍，聽起來像金屬聲，辨識率會掉。
 *
 * ⚠️ 回傳值帶著實際取樣率，而不是硬回 16000。
 * 來源比目標還低時（少見，但藍牙耳機麥克風可能是 8kHz）不做假的升取樣——
 * 補出來的取樣沒有新資訊，卻會讓標頭寫的取樣率與內容對不上，
 * 那是最難查的一類 bug：檔案「看起來」正常，只是講話速度不對。
 */
export function downsampleTo16k(input: Float32Array, inputRate: number): Downsampled {
  if (!Number.isFinite(inputRate) || inputRate <= 0) {
    throw new Error(`取樣率不合法：${inputRate}`);
  }
  if (inputRate <= TARGET_SAMPLE_RATE) {
    return { samples: input, sampleRate: inputRate };
  }

  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
      count++;
    }
    out[i] = count > 0 ? sum / count : 0;
  }

  return { samples: out, sampleRate: TARGET_SAMPLE_RATE };
}

/**
 * Float32（[-1, 1]）轉 16-bit 整數。
 *
 * 負負值域不對稱是刻意的：Int16 的範圍是 -32768 ~ 32767，
 * 兩邊都乘 32767 會讓 -1.0 對不到最小值；兩邊都乘 32768 則會讓 +1.0 溢位變成 -32768，
 * 也就是最大聲的地方變成反相的爆音。所以要分開乘。
 */
export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

/** 把 AudioWorklet 一塊一塊送上來的緩衝接成一整段 */
export function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;

  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** 標頭用的 ASCII 寫入。WAV 的四字元標記全是 ASCII，不用管編碼。 */
function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * 加上 44 bytes 的 RIFF 標頭。單聲道、16-bit、PCM。
 * ⚠️ WAV 標頭全部是 little-endian（`setUint32` 第三個參數 true），寫成大端會整個檔案讀不出來。
 */
export function encodeWav(samples: Int16Array, sampleRate = TARGET_SAMPLE_RATE): Uint8Array {
  const channels = 1;
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  // 整個檔案扣掉 "RIFF" 與這個長度欄位本身 ＝ 36 ＋ 資料長度
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");

  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk 長度，PCM 固定 16
  view.setUint16(20, 1, true); // 1 ＝ 未壓縮 PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, channels * BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true); // bits per sample

  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    view.setInt16(WAV_HEADER_BYTES + i * BYTES_PER_SAMPLE, samples[i], true);
  }

  return new Uint8Array(buffer);
}

/**
 * 錄到的 Float32 塊 → 可以直接上傳的 WAV。錄音端唯一需要呼叫的東西。
 */
export function chunksToWav(chunks: readonly Float32Array[], inputRate: number): Uint8Array {
  const { samples, sampleRate } = downsampleTo16k(concatFloat32(chunks), inputRate);
  return encodeWav(floatToInt16(samples), sampleRate);
}

/** 這段 WAV 有多長（秒）。用來擋「按住不放三分鐘」這種燒額度的玩法。 */
export function wavDurationSeconds(byteLength: number, sampleRate = TARGET_SAMPLE_RATE): number {
  const dataBytes = Math.max(0, byteLength - WAV_HEADER_BYTES);
  return dataBytes / (sampleRate * BYTES_PER_SAMPLE);
}

export interface WavHeader {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  durationSeconds: number;
}

/**
 * 解析並驗證 WAV 標頭。**伺服器端用**——不可以相信客戶端說了什麼。
 *
 * 回 null 代表這不是一個合法的 WAV。要在付錢給 Gemini **之前**擋掉，
 * 否則隨便一個 POST 垃圾位元組的腳本都能燒我們的額度。
 *
 * ⚠️ 一定要**走訪區塊**去找 `fmt ` 與 `data`，不可以假設它們在 offset 12 與 36。
 * 那個假設對我們自己編的檔案成立，對別人的不成立——ffmpeg 就會插進 LIST/INFO 區塊。
 * 實際踩到的症狀：一個 40 秒的檔案被算成 0 秒，於是繞過了 30 秒上限。
 * 時長上限是成本控制，能被「多加一個區塊」繞過就等於沒有。
 *
 * ⚠️ 時長要從標頭裡的取樣率算，不能假設是 16000。
 * 藍牙麥克風可能給 8kHz（見 downsampleTo16k 的說明），
 * 用錯的取樣率算時長，「30 秒上限」會變成實際 60 秒。
 */
export function parseWavHeader(bytes: Uint8Array): WavHeader | null {
  if (bytes.length < WAV_HEADER_BYTES) return null;

  const ascii = (offset: number) =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (ascii(0) !== "RIFF" || ascii(8) !== "WAVE") return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataBytes = -1;

  // RIFF 區塊從 offset 12 開始：每塊是 4 bytes 名稱 ＋ 4 bytes 長度 ＋ 內容（補足偶數）
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === "fmt " && size >= 16 && body + 16 <= bytes.length) {
      // 只收未壓縮 PCM
      if (view.getUint16(body, true) !== 1) return null;
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === "data") {
      // 宣告的長度可能超過實際內容（截斷的上傳），取較小值才不會高估時長
      dataBytes = Math.max(0, Math.min(size, bytes.length - body));
      break;
    }

    // 區塊長度是奇數時要補一個 padding byte。
    // 少了這行，遇到奇數長度的區塊之後每一塊都會錯位。
    const advance = size + (size % 2);
    // 長度欄位可以被造假成 0 或極大值——沒有這道防護就是無窮迴圈或整數溢位
    if (advance <= 0 || body + advance > bytes.length) break;
    offset = body + advance;
  }

  if (channels < 1 || sampleRate < 1 || bitsPerSample < 8 || dataBytes < 0) return null;

  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  return {
    sampleRate,
    channels,
    bitsPerSample,
    dataBytes,
    durationSeconds: bytesPerSecond > 0 ? dataBytes / bytesPerSecond : 0,
  };
}
