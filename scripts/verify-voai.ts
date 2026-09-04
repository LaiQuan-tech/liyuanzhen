/**
 * 閘門驗證：VoAI（絕好聲創）能不能取代 ElevenLabs 當 /live 的聲音。
 *
 * 🔴 這支存在的理由跟 verify-stt.ts 完全一樣：**格式支援這種事要實測，
 * 不要照文件推論**。上一次照文件推論「Gemini 不吃 webm」，換來一條跨三個
 * 地雷區的錯誤管線和五輪「按住說話沒反應」。
 *
 * 這裡要驗的四件事，每一件失敗都會讓換供應商這件事整個不成立：
 *
 * 1. **pcm 到底是不是裸 PCM。** LiveAvatar LITE 只吃裸 PCM，一個 RIFF 標頭
 *    就會讓它把標頭當成取樣播出去。文件沒寫，只能打。
 * 2. **取樣率。** SDK 把 24000 寫死在自己的分塊邏輯裡
 *    （node_modules/@heygen/liveavatar-web-sdk/lib/index.esm.js:801），
 *    而 VoAI 只給 8000/16000/32000/44100。這支印出實際位元組數，
 *    好算出真正的取樣率、確認要不要重取樣。
 * 3. **首字延遲。** 現在這條路能用，是因為 ElevenLabs 的 /stream 邊生邊回。
 *    非串流版合一段 3~5 句要 7.8 秒，而那 7.8 秒全在她開口之前。
 *    VoAI 文件說 pcm 會 streaming，這支量第一個位元組到手要多久。
 * 4. **中文咬字。** 這個站的內容是婦運史，人名與專有名詞密度極高。
 *    這支把音檔存成 wav 讓人真的去聽——這一項機器驗不了。
 *
 * ⚠️ 金鑰**不要寫進任何檔案**（包含 .env.local）。用行內環境變數跑：
 *   VOAI_API_KEY=xxx npx tsx scripts/verify-voai.ts
 *   VOAI_API_KEY=xxx npx tsx scripts/verify-voai.ts "要念的句子"
 */
import { writeFileSync } from "node:fs";
import { looksLikeWav } from "../lib/voice/pcm";

const BASE = "https://connect.voai.ai";
/** LiveAvatar LITE 要的取樣率。VoAI 沒有這個選項，所以拿 32000 回來自己降。 */
const TARGET_RATE = 24_000;
/** 3:4 是乾淨的有理數比，16000 起跳會明顯變悶，44100 的比例很醜。 */
const REQUEST_RATE = 32_000;

/** 這句刻意塞滿這個站真的會念到的人名與專有名詞。 */
const DEFAULT_TEXT =
  "李元貞在一九八二年創辦《婦女新知》雜誌社，一九八七年改組為婦女新知基金會，" +
  "後來又寫了《眾女成城：台灣婦運回憶錄》。";

function pcmSeconds(bytes: number, rate: number): number {
  return bytes / (rate * 2);
}

/** 裸 PCM 加上 WAV 標頭，好讓人用一般播放器聽。 */
function wrapWav(pcm: Uint8Array, rate: number): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, Buffer.from(pcm)]);
}

async function main() {
  const key = process.env.VOAI_API_KEY;
  if (!key) {
    console.error("缺 VOAI_API_KEY。用行內環境變數跑，不要寫進 .env.local：");
    console.error('  VOAI_API_KEY=xxx npx tsx scripts/verify-voai.ts');
    process.exit(1);
  }
  const text = process.argv[2] ?? DEFAULT_TEXT;

  // ── 1. 語者清單 ────────────────────────────────────────────
  console.log("── 語者清單 ──");
  const listRes = await fetch(`${BASE}/TTS/GetSpeaker`, {
    headers: { "x-api-key": key },
  });
  console.log(`GET /TTS/GetSpeaker → ${listRes.status}`);
  const listBody = await listRes.text();
  if (!listRes.ok) {
    console.error(listBody.slice(0, 500));
    process.exit(1);
  }
  // 實際結構：{ data: { models: [{ info: { version }, speakers: [{ name, styles, age, gender, ... }] }] } }
  const parsed = JSON.parse(listBody) as {
    data: { models: { info: { version: string }; speakers: { name: string; age?: number; gender?: string; styles?: string[] }[] }[] };
  };
  for (const m of parsed.data.models) {
    console.log(`  ${m.info.version}：${m.speakers.length} 位`);
  }

  const version = process.env.VOAI_VERSION ?? "Neo";
  const model = parsed.data.models.find((m) => m.info.version === version);
  if (!model) {
    console.error(`找不到版本 ${version}`);
    process.exit(1);
  }
  // 預設挑年紀最接近李元貞（1946 年生）的女聲。真的要上線是用她的克隆聲，
  // 這裡只是為了驗格式與延遲，挑誰不影響結論。
  const pick =
    process.env.VOAI_SPEAKER ??
    model.speakers
      .filter((s) => s.gender === "女聲")
      .sort((a, b) => (b.age ?? 0) - (a.age ?? 0))[0]?.name ??
    model.speakers[0].name;
  const style = process.env.VOAI_STYLE ?? model.speakers.find((s) => s.name === pick)?.styles?.[0] ?? "預設";
  console.log(`\n用 ${version} 的「${pick}」（style=${style}）測`);

  // ── 2. 合成 ────────────────────────────────────────────────
  console.log("\n── 合成 ──");
  console.log(`要求 x-output-format: pcm、x-sample-rate: ${REQUEST_RATE}`);
  const t0 = Date.now();
  const res = await fetch(`${BASE}/TTS/Speech`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "Content-Type": "application/json",
      "x-output-format": "pcm",
      "x-sample-rate": String(REQUEST_RATE),
    },
    body: JSON.stringify({
      version,
      text,
      speaker: pick,
      style,
      speed: 1.0,
      pitch_shift: 0,
      style_weight: 0,
      breath_pause: 0,
    }),
  });
  console.log(`POST /TTS/Speech → ${res.status} ${res.headers.get("content-type") ?? ""}`);
  if (!res.ok) {
    console.error((await res.text()).slice(0, 800));
    process.exit(1);
  }

  // 首字延遲：第一塊到手的時間，這是決定能不能用的關鍵數字
  const reader = res.body!.getReader();
  const parts: Uint8Array[] = [];
  let first = 0;
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!first) {
      first = Date.now() - t0;
      console.log(`首個位元組 ${first}ms（${value.byteLength} bytes）`);
    }
    parts.push(value);
    total += value.byteLength;
  }
  const elapsed = Date.now() - t0;
  const pcm = Buffer.concat(parts);

  console.log(`\n── 結果 ──`);
  console.log(`總長 ${total} bytes、全部收完 ${elapsed}ms、分 ${parts.length} 塊`);
  console.log(`開頭四個位元組：${Array.from(pcm.subarray(0, 4)).map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  const wav = looksLikeWav(pcm);
  console.log(`是不是 WAV（有 RIFF 標頭）：${wav ? "🔴 是 —— LiveAvatar 不吃，要自己剝掉標頭" : "✓ 不是，是裸 PCM"}`);
  const body = wav ? pcm.subarray(44) : pcm;
  console.log(`若真的是 ${REQUEST_RATE}Hz → 這段話 ${pcmSeconds(body.byteLength, REQUEST_RATE).toFixed(2)} 秒`);
  console.log(`若其實是 ${TARGET_RATE}Hz → 這段話 ${pcmSeconds(body.byteLength, TARGET_RATE).toFixed(2)} 秒`);
  console.log("（哪個數字接近真人念這句話的長度，實際取樣率就是哪個）");

  const out = "/tmp/voai-check.wav";
  writeFileSync(out, wrapWav(body, REQUEST_RATE));
  console.log(`\n音檔已存到 ${out} —— 請實際聽一次，重點是人名與書名的咬字。`);
  console.log("⚠️ 若聽起來速度不對，就代表實際取樣率不是我們要求的那個。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
