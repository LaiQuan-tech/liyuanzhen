/**
 * 認出上傳進來的到底是什麼音訊容器。純函式，所以測得到。
 *
 * ⚠️ **不要相信 Content-Type。** 這支端點接受任意二進位上傳，隨便一個腳本
 * POST 一坨垃圾、標頭寫 audio/webm，我們就要付錢給 Gemini。
 * 原本的守門是 parseWavHeader（只收 WAV），改用 MediaRecorder 之後容器變成三種，
 * 但「自己看位元組」這條紀律要留著。
 *
 * ⚠️ 只認容器、不驗內容。這裡的目的是擋垃圾與擋錯格式，不是做完整驗證——
 * 真的壞掉的音訊由 Gemini 回空字串，那條路前端已經處理了。
 */

/** Gemini 收得下、而且瀏覽器產得出來的容器。實測見 lib/live/recorder.ts 檔頭。 */
export type AudioContainer = "audio/webm" | "audio/ogg" | "audio/mp4" | "audio/wav";

function has(bytes: Uint8Array, offset: number, ascii: string): boolean {
  if (bytes.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * 從開頭的魔術位元組認容器。認不出來回 null——呼叫端應該回 400 而不是送去 Gemini。
 *
 * 各容器的辨識依據：
 *   WebM／Matroska … EBML 標頭 `1A 45 DF A3`
 *   Ogg …………………… `OggS`
 *   MP4／M4A ………… 第 4~7 個位元組是 `ftyp`（前四個是 box 長度）
 *   WAV …………………… `RIFF` ＋ 第 8~11 個位元組是 `WAVE`
 */
export function sniffAudioContainer(bytes: Uint8Array): AudioContainer | null {
  if (bytes.length < 12) return null;

  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "audio/webm";
  }
  if (has(bytes, 0, "OggS")) return "audio/ogg";
  if (has(bytes, 4, "ftyp")) return "audio/mp4";
  if (has(bytes, 0, "RIFF") && has(bytes, 8, "WAVE")) return "audio/wav";

  return null;
}
