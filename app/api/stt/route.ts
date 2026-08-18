import type { NextRequest } from "next/server";
import { transcribe, hasSttCredentials } from "@/lib/stt";
import { parseWavHeader } from "@/lib/live/wav";
import { clientIp, sttRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * 把訪客按住說話錄下來的 WAV 轉成文字。/live 的第一站。
 *
 * ⚠️ 這支端點會花錢（Gemini 額度），跟 /api/chat 一樣要守。
 * 而且它比其他兩支更容易被當成沙包——**接受任意二進位上傳**的端點，
 * 隨便一個腳本 POST 一坨垃圾就能讓我們付錢給 Gemini。
 * 所以驗證順序刻意是「便宜的先做」：來源 → 限流 → 大小 → 標頭 → 才呼叫 Gemini。
 */

/**
 * 30 秒。一個問題再長也不會到這個數字，設上限是為了擋「按住不放」燒額度。
 * Gemini 音訊計費約 32 token/秒，30 秒 ≈ 960 token，還在可控範圍。
 */
const MAX_AUDIO_SECONDS = 30;

/**
 * 位元組上限。16kHz 單聲道 16-bit ＝ 32KB/秒，所以 30 秒約 960KB。
 * 抓 1.5MB 留餘裕給較高取樣率的來源，同時仍然遠低於會撐爆記憶體的量。
 *
 * ⚠️ 這道檢查必須在**讀進記憶體之前**用 Content-Length 做一次，
 * 否則「先讀完再檢查」等於讓攻擊者決定我們配置多少記憶體。
 */
const MAX_AUDIO_BYTES = 1_500_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** 跟 /api/chat 同一套第一道防線。腳本可偽造，所以只是減速丘。 */
function originAllowed(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!originAllowed(request)) {
    return json({ error: "請從本網站發起請求。" }, 403);
  }

  // 沒設定就明確回 503，讓前端知道要退回文字輸入，而不是等到逾時
  if (!hasSttCredentials()) {
    return json({ error: "語音辨識未設定。", reason: "not_configured" }, 503);
  }

  const verdict = sttRateLimit(clientIp(request.headers));
  if (!verdict.ok) {
    return json({ error: "請稍等一下再試。", reason: verdict.reason }, 429);
  }

  // ⚠️ 先看 Content-Length 再讀 body。順序反過來就是讓對方決定我們吃多少記憶體。
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_AUDIO_BYTES) {
    return json({ error: "錄音過長。", reason: "too_large" }, 413);
  }

  let audio: Uint8Array;
  try {
    audio = new Uint8Array(await request.arrayBuffer());
  } catch {
    return json({ error: "讀取音訊失敗。" }, 400);
  }

  // Content-Length 可以造假，實際讀到的長度才算數
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return json({ error: "錄音過長。", reason: "too_large" }, 413);
  }

  // 不相信客戶端說的格式——自己解標頭。垃圾位元組在這裡就該被擋下，不要送去 Gemini。
  const header = parseWavHeader(audio);
  if (!header) {
    return json({ error: "音訊格式不正確。", reason: "bad_format" }, 400);
  }
  if (header.durationSeconds > MAX_AUDIO_SECONDS) {
    return json({ error: "錄音過長。", reason: "too_long" }, 413);
  }
  if (header.durationSeconds < 0.2) {
    // 按一下就放開。這不是錯誤，只是沒有內容——回空字串讓前端安靜地忽略。
    return json({ transcript: "" });
  }

  try {
    const transcript = await transcribe(audio);
    // ⚠️ 空字串是正常結果（沒聽到人聲），不是錯誤。
    // 回 200 讓前端知道「有跑完，只是沒東西」，跟 502 要分得開。
    return json({ transcript });
  } catch (error) {
    console.error("[stt] 轉錄失敗：", error);
    return json({ error: "語音辨識失敗。" }, 502);
  }
}
