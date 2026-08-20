/**
 * 閘門驗證：Gemini 到底吃不吃瀏覽器 MediaRecorder 產出的容器。
 *
 * 🔴 這支存在的理由是一個代價很大的錯誤。
 *
 * 原本這支驗的是「Gemini 吃不吃我們自己編的 WAV」，因為官方文件列的支援清單是
 * wav / mp3 / aiff / aac / ogg / flac，**沒有 webm**，而 MediaRecorder 在 Chrome
 * 只吐 webm。於是整條輸入路徑改走 AudioWorklet 自己編 WAV。
 *
 * 那個推論從來沒有被實測過，而且是錯的。2026-08-20 實打 gemini-3.5-flash：
 * webm/opus、Chrome 式無總長度 webm、ogg/opus、Safari 的 mp4/aac，全部 200、
 * 逐字稿正確。錯誤前提換來的是一條跨 AudioContext ／ AudioWorklet ／
 * 自動播放政策的管線，以及五輪「按住說話沒反應」。
 *
 * 所以這支現在驗的是**真正該驗的那件事**：把一個檔案丟進去，
 * 看它是不是被認得出容器、而且 Gemini 收得下。
 *
 * ⚠️ 一樣呼叫 `lib/stt` 的 `transcribe()` 而不是自己寫一份 API 呼叫——
 * 驗的必須是真的會上線的那條路，否則驗過了也不代表什麼。
 *
 * 用法：
 *   npm run verify:stt -- 某段語音.webm
 *
 * 想一次驗完三種瀏覽器會產生的格式：
 *   ffmpeg -i 語音.wav -c:a libopus -f webm -live 1 chrome.webm
 *   ffmpeg -i 語音.wav -c:a libopus firefox.ogg
 *   ffmpeg -i 語音.wav -c:a aac safari.m4a
 */
import { readFileSync } from "node:fs";
import { sniffAudioContainer } from "../lib/live/audio-format";
import { transcribe, hasSttCredentials, STT_MODEL } from "../lib/stt";

async function main() {
  if (!hasSttCredentials()) {
    console.error("缺 GEMINI_API_KEY");
    process.exit(1);
  }

  const path = process.argv[2];
  if (!path) {
    console.error("用法：npm run verify:stt -- <音訊檔>");
    process.exit(1);
  }

  const bytes = new Uint8Array(readFileSync(path));

  // ⚠️ 先過守門那一關。伺服器不相信 Content-Type，這裡也不要相信副檔名。
  const container = sniffAudioContainer(bytes);
  if (!container) {
    console.error(`✗ 認不出容器——這個檔案會被 /api/stt 以 400 擋下`);
    process.exit(1);
  }

  console.log(`檔案 ${path}`);
  console.log(`容器 ${container}（看位元組認的，不是副檔名）`);
  console.log(`大小 ${bytes.byteLength} bytes`);
  console.log(`模型 ${STT_MODEL}`);

  const began = Date.now();
  const transcript = await transcribe(bytes, container);
  const elapsed = Date.now() - began;

  if (!transcript) {
    console.error(`✗ ${elapsed}ms 回了空字串——收得下但沒聽出人聲`);
    process.exit(1);
  }
  console.log(`✓ ${elapsed}ms`);
  console.log(`逐字稿：${transcript}`);
}

void main();
