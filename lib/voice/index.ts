import { chunkPcm, looksLikeWav, pcmDurationSeconds } from "./pcm";
import { fixPronunciation } from "./pronunciation";

export { fixPronunciation, PRONUNCIATION_FIXES } from "./pronunciation";

export {
  chunkPcm,
  looksLikeWav,
  pcmDurationSeconds,
  SAMPLE_RATE,
  BYTES_PER_SECOND,
  DEFAULT_CHUNK_MS,
} from "./pcm";

/**
 * 用老師的克隆聲音合成語音，輸出 LiveAvatar LITE mode 直接吃得下的格式。
 *
 * ⚠️ `output_format=pcm_24000` 這個參數是整條路的關鍵，不要改成別的：
 * ElevenLabs 預設回 mp3，而 LiveAvatar 只吃裸 PCM 16-bit 24kHz 單聲道。
 * 兩邊逐位元對得上，中間不需要任何轉檔——這是選 ElevenLabs 的實質好處之一。
 */

const API_BASE = "https://api.elevenlabs.io/v1/text-to-speech";

/**
 * ⚠️ 一定要用 `/stream`，不要用非串流版本。
 *
 * 實測：非串流版合成一段 3–5 句的回答要 **7.8 秒**，而那 7.8 秒全部發生在
 * 她開口之前——端到端從送出問題到出聲是 12.9 秒，沒有人會等。
 * `/stream` 邊生邊回，第一塊到手就能送進 avatar 的播放緩衝，
 * 之後的塊在她講前面時陸續補上。
 */
const STREAM_SUFFIX = "/stream";

/**
 * 🔴 2026-09-04 從 `eleven_multilingual_v2` 換成這一支，理由是**台灣口音**。
 *
 * 使用者回報「不像台灣人的口音」。克隆聲音的口音由兩件事決定：她本人的錄音，
 * 加上模型的韻律先驗。`multilingual_v2` 是 29 語言的通用模型，中文韻律偏向
 * 對岸，會把她的口音拉平——問題出在模型，不是克隆。
 *
 * 換之前拿她**同一個克隆聲**、同一句話（塞滿《婦女新知》《眾女成城》這類
 * 這個站真的會念到的專有名詞）跑過四個模型，存成 wav 給使用者實際聽，
 * 由他挑的。四個都吃 `pcm_24000` 串流，所以換模型只是改這一個常數。
 *
 * 實測首字延遲（同一句、同一個 voice id）：
 *   eleven_multilingual_v2     1,610ms   ← 舊的
 *   eleven_flash_v2_5          2,771ms
 *   eleven_v3_conversational   3,599ms   ← 現在這個
 *   eleven_v3                  4,155ms
 *
 * ⚠️ 代價是每一題多約兩秒的等待。這是知情的取捨：口音錯是每一句都錯，
 * 慢兩秒是每一句都慢兩秒，使用者選了前者比較重要。
 *
 * ⚠️ **不要換成 flash 系列去省延遲**——那會犧牲中文咬字，而這個站的內容是
 * 婦運史，人名與專有名詞密度極高，念錯的代價比慢兩秒大得多。
 *
 * ⚠️ 生成速度也跟著變慢：v2 約 7 倍實時（12.26 秒音訊只花 1.73 秒），
 * v3_conversational 約 2.25 倍（11.44 秒音訊花 5.08 秒）。
 * 回答上限 500 字換算成語音約 100 秒，用 2.25 倍算要 45 秒——**超過
 * `app/api/tts/route.ts` 的 `maxDuration = 30`**。所以那支的 maxDuration
 * 一起放寬到 60，見那裡的註解。
 */
const MODEL_ID = "eleven_v3_conversational";

export interface SynthesisResult {
  /** base64 的 PCM 塊，照順序送 */
  chunks: string[];
  /** 這段話多長（秒）。呼叫端用它記帳。 */
  seconds: number;
}

export function hasTtsCredentials(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
}

/**
 * 串流版：回傳還在傳輸中的 PCM 位元組流。
 *
 * 呼叫端（/api/tts）直接把它轉給瀏覽器，瀏覽器每收滿約一秒就送進 avatar 的
 * 播放緩衝。**整條路上沒有任何一段在等完整音訊**，這是把 12.9 秒壓下來的關鍵。
 */
export async function synthesizeStream(text: string): Promise<ReadableStream<Uint8Array>> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) throw new Error("缺 ELEVENLABS_API_KEY 或 ELEVENLABS_VOICE_ID");

  const response = await fetch(
    `${API_BASE}/${voiceId}${STREAM_SUFFIX}?output_format=pcm_24000`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ text: fixPronunciation(text), model_id: MODEL_ID }),
    }
  );

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`ElevenLabs 合成失敗 ${response.status}：${detail.slice(0, 200)}`);
  }
  return response.body;
}

export async function synthesize(text: string): Promise<SynthesisResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) {
    throw new Error("缺 ELEVENLABS_API_KEY 或 ELEVENLABS_VOICE_ID");
  }

  const response = await fetch(
    `${API_BASE}/${voiceId}${STREAM_SUFFIX}?output_format=pcm_24000`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ text: fixPronunciation(text), model_id: MODEL_ID }),
    }
  );

  if (!response.ok) {
    // 不要把回應內容原封不動往外丟——ElevenLabs 的錯誤訊息有時會帶回請求內容
    const detail = await response.text().catch(() => "");
    throw new Error(
      `ElevenLabs 合成失敗 ${response.status}：${detail.slice(0, 200)}`
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  // 這個檢查不是防禦性程式碼寫過頭：`pcm_24000` 打錯成 `riff-...` 時，
  // 症狀是每塊開頭爆一聲，很容易被誤判成網路問題，除錯會繞遠路。
  if (looksLikeWav(bytes)) {
    throw new Error(
      "ElevenLabs 回的是 WAV 不是裸 PCM——檢查 output_format 是不是被改掉了"
    );
  }

  return { chunks: chunkPcm(bytes), seconds: pcmDurationSeconds(bytes.length) };
}
