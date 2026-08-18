/**
 * 閘門驗證：Gemini 到底吃不吃我們自己編出來的 WAV。
 *
 * 為什麼需要這支：Gemini 接受的音訊格式是 wav / mp3 / aiff / aac / ogg / flac，
 * **沒有 webm**——而 MediaRecorder 在 Chrome 只吐 `audio/webm;codecs=opus`。
 * 所以我們不用 MediaRecorder，改走 Web Audio 自己編 WAV（lib/live/wav.ts）。
 *
 * ⚠️ 兩個刻意的設計：
 *
 * 1. 讓音訊**走過我們自己的編碼器**，而不是用 ffmpeg 直接產一個 WAV。
 *    後者只能證明「Gemini 吃 WAV」，證明不了「Gemini 吃**我們編的** WAV」——
 *    而真正會出錯的是後者（標頭端序、取樣率欄位、Int16 溢位）。
 *
 * 2. 呼叫 `lib/stt` 的 `transcribe()` 而不是自己寫一份 API 呼叫。
 *    驗的必須是真的會上線的那條路，否則驗過了也不代表什麼。
 *
 * 用法：
 *   ffmpeg -i 某段中文語音.mp3 -ac 1 -ar 48000 -f f32le mic-sim.raw
 *   npm run verify:stt -- mic-sim.raw [來源取樣率]
 *
 * 那個 .raw 就是瀏覽器 AudioWorklet 會交給我們的東西（單聲道 Float32），
 * 所以這支等於在沒有瀏覽器的情況下重演整條輸入路徑。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { chunksToWav, wavDurationSeconds, TARGET_SAMPLE_RATE } from "../lib/live/wav";
import { transcribe, hasSttCredentials, STT_MODEL } from "../lib/stt";

async function main() {
  if (!hasSttCredentials()) {
    console.error("缺 GEMINI_API_KEY");
    process.exit(1);
  }

  const path = process.argv[2];
  if (!path) {
    console.error("用法：npm run verify:stt -- <f32le 裸音訊> [來源取樣率，預設 48000]");
    process.exit(1);
  }
  const inputRate = Number(process.argv[3] ?? 48_000);

  // 讀進來的是裸 Float32（little-endian），正是 AudioWorklet 會給我們的格式
  const raw = readFileSync(path);
  const floats = new Float32Array(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
  );
  console.log(
    `來源：${floats.length} 個取樣 @ ${inputRate}Hz ＝ ${(floats.length / inputRate).toFixed(1)} 秒`
  );

  // ← 這一行就是要驗的編碼器
  const wav = chunksToWav([floats], inputRate);
  const seconds = wavDurationSeconds(wav.length);
  console.log(
    `編碼後：${(wav.length / 1024).toFixed(0)} KB @ ${TARGET_SAMPLE_RATE}Hz ＝ ` +
      `${seconds.toFixed(1)} 秒（${(wav.length / 1024 / seconds).toFixed(0)} KB/秒）`
  );

  // 落一份檔案，人耳可以直接開來聽——標頭寫壞的話這裡就播不出來了
  const wavPath = `${path.replace(/\.[^.]+$/, "")}.our-encoder.wav`;
  writeFileSync(wavPath, wav);
  console.log(`已寫出 ${wavPath}（可以直接播來確認沒有雜訊或速度不對）\n`);

  const started = Date.now();
  const transcript = await transcribe(wav);
  const elapsed = Date.now() - started;

  console.log(`${STT_MODEL} 回應（${elapsed}ms）：`);
  console.log("─".repeat(60));
  console.log(transcript || "（空的——代表沒聽到人聲）");
  console.log("─".repeat(60));

  if (!transcript) {
    console.error("\n❌ 閘門未通過：沒有回出逐字稿。");
    process.exit(1);
  }
  console.log(`\n✅ 閘門通過：${transcript.length} 字，${elapsed}ms。`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
