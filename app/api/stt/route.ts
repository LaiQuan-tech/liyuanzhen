import type { NextRequest } from "next/server";
import { transcribe, hasSttCredentials } from "@/lib/stt";
import { sniffAudioContainer } from "@/lib/live/audio-format";
import { clientIp, sttRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * 預熱。
 *
 * 🔴 這支存在的理由是原本的預熱**打錯了對象**。
 * `/live` 掛載時 ping 的是 `/api/health`，而那支在正式站是被 Vercel 邊緣快取的
 *（實測 `x-vercel-cache: HIT`、`age: 141`），請求根本到不了任何 lambda。
 * 真正需要熱的是這一支，而它從來沒被熱過。
 *
 * 症狀：安靜一段時間之後的第一個問題會撞上冷啟動。實測正式站上一次
 * 超過 20 秒而被前端的逾時丟掉，訪客看到的是「抱歉，我需要休息一下」——
 * 一個完全正確的請求，被當成失敗。
 *
 * ⚠️ 這支刻意什麼都不做。lambda 被叫醒、模組被求值，預熱就完成了；
 * 多做任何事都只是給不需要的人花錢。
 */
export async function GET() {
  return new Response(JSON.stringify({ warm: true }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}


/**
 * 把訪客按住說話錄下來的音訊轉成文字。/live 的第一站。
 *
 * ⚠️ 這支端點會花錢（Gemini 額度），跟 /api/chat 一樣要守。
 * 而且它比其他兩支更容易被當成沙包——**接受任意二進位上傳**的端點，
 * 隨便一個腳本 POST 一坨垃圾就能讓我們付錢給 Gemini。
 * 所以驗證順序刻意是「便宜的先做」：來源 → 限流 → 大小 → 標頭 → 才呼叫 Gemini。
 */

/**
 * 位元組上限。
 *
 * 客戶端用 24kbps 的 opus 錄音（見 lib/live/recorder.ts 的 AUDIO_BITS_PER_SECOND），
 * 30 秒約 90KB；正式站實測 Chrome 錄 4 秒是 7KB（比要求的還低）。
 *
 * ⚠️ 但**不可以**照 Chrome 的數字抓。`audioBitsPerSecond` 是建議不是保證，
 * Safari 的 AAC 預設在 64~128kbps，30 秒就是 240~480KB。抓 250KB 的話，
 * 一個用 iPhone 問了長問題的訪客會拿到 413——而那在畫面上跟壞掉沒有分別。
 * 600KB 讓最壞情況（128kbps × 30 秒）也進得來。
 *
 * ⚠️ **這個數字取代了原本的「解 WAV 標頭算秒數」那道門，而它比較弱，要老實承認。**
 * 壓縮容器的長度不看完整個檔案算不出來，而 Chrome 的 webm 標頭裡根本沒有總長度
 *（實測 ffprobe 回 N/A）。對方如果刻意用極低位元率編碼，250KB 可以塞進好幾分鐘。
 * 擋這種人的是每 IP 限流那一道，不是這一道；這一道擋的是正常使用者「按住不放」
 * 與「隨手 POST 一個大檔」。客戶端自己也有 30 秒上限。
 *
 * ⚠️ 這道檢查必須在**讀進記憶體之前**用 Content-Length 做一次，
 * 否則「先讀完再檢查」等於讓攻擊者決定我們配置多少記憶體。
 */
const MAX_AUDIO_BYTES = 600_000;

/**
 * 只有標頭、沒有內容。回空字串讓前端安靜地忽略，不要送去 Gemini 白花錢。
 * 跟客戶端的 EMPTY_AUDIO_BYTES 同一個意思。
 */
const EMPTY_AUDIO_BYTES = 800;

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

  // ⚠️ 不相信客戶端說的格式——自己看開頭的魔術位元組。
  // 垃圾在這裡就該被擋下，不要送去 Gemini。
  const container = sniffAudioContainer(audio);
  if (!container) {
    return json({ error: "音訊格式不正確。", reason: "bad_format" }, 400);
  }
  if (audio.byteLength <= EMPTY_AUDIO_BYTES) {
    // 按一下就放開。這不是錯誤，只是沒有內容。
    return json({ transcript: "" });
  }

  try {
    const transcript = await transcribe(audio, container);
    // ⚠️ 空字串是正常結果（沒聽到人聲），不是錯誤。
    // 回 200 讓前端知道「有跑完，只是沒東西」，跟 502 要分得開。
    return json({ transcript });
  } catch (error) {
    console.error("[stt] 轉錄失敗：", error);
    return json({ error: "語音辨識失敗。" }, 502);
  }
}
