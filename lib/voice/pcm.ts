/**
 * LiveAvatar LITE mode 的音訊格式處理。純函式、無 IO，所以可以完整單元測試。
 *
 * 規格來自官方文件，三個數字都不能改：
 *   PCM **16-bit**、**24 kHz**、**單聲道**，base64 編碼，
 *   建議每塊約 1 秒，單一 WebSocket 封包上限 1 MB。
 *
 * ⚠️ 必須是**裸 PCM**，不能是 WAV。WAV 前面那 44 bytes 的 RIFF 標頭會被當成
 * 音訊取樣值送進去，結果是每一塊開頭都有一聲爆音。
 * ElevenLabs 的 `output_format=pcm_24000` 直接給裸 PCM，已實測確認開頭不是 "RIFF"。
 */

export const SAMPLE_RATE = 24_000;
/** 16-bit ＝ 每個取樣 2 bytes */
export const BYTES_PER_SAMPLE = 2;
/** 24000 × 2 ＝ 每秒 48000 bytes */
export const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE;

/** 官方建議值。1 秒 ＝ 48000 bytes ＝ base64 後 64000 字元，離 1 MB 上限很遠。 */
export const DEFAULT_CHUNK_MS = 1000;

/**
 * 把裸 PCM 切成 base64 塊。
 *
 * ⚠️ 每塊的 byte 數**必須是偶數**，否則會把一個 16-bit 取樣從中間切開，
 * 後續每一塊的高低位元組全部錯位——症狀是整段變成刺耳的雜訊而不是「有點怪」。
 * 所以這裡強制對齊到 BYTES_PER_SAMPLE。
 */
export function chunkPcm(pcm: Uint8Array, chunkMs = DEFAULT_CHUNK_MS): string[] {
  const raw = Math.floor((BYTES_PER_SECOND * chunkMs) / 1000);
  // 向下對齊到取樣邊界；再保底至少一個取樣，避免 chunkMs 傳 0 時無限迴圈
  const size = Math.max(BYTES_PER_SAMPLE, raw - (raw % BYTES_PER_SAMPLE));

  const chunks: string[] = [];
  for (let offset = 0; offset < pcm.length; offset += size) {
    const slice = pcm.subarray(offset, Math.min(offset + size, pcm.length));
    chunks.push(Buffer.from(slice).toString("base64"));
  }
  return chunks;
}

/** 這段 PCM 有多長（秒）。用來記帳與判斷是否超過單次上限。 */
export function pcmDurationSeconds(byteLength: number): number {
  return byteLength / BYTES_PER_SECOND;
}

/**
 * 是不是被誤送成 WAV 了。
 * 這個檢查存在的理由：`riff-24khz-16bit-mono-pcm` 與 `pcm_24000` 只差一個參數名，
 * 而送錯的症狀（每塊開頭爆音）在開發時很容易被當成「網路不穩」。
 */
export function looksLikeWav(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 //// F
  );
}
