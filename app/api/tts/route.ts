import type { NextRequest } from "next/server";
import { synthesizeStream, hasTtsCredentials } from "@/lib/voice";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * 把答案文字合成成老師的聲音，回傳 LiveAvatar 吃得下的 base64 PCM 塊。
 *
 * ⚠️ 這支端點會花錢（ElevenLabs 額度），跟 /api/chat 一樣要守。
 *
 * ⚠️ 為什麼上限是 600 字：persona 規則限制回答 3–5 句，正常答案遠低於這個數字。
 * 設上限是為了擋「把整本書貼進來合成」這種燒額度的玩法，不是為了限制正常使用。
 */
const MAX_TEXT_CHARS = 600;

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

  // 沒設定就明確回 503，讓前端知道要退回無聲模式，而不是等到逾時。
  if (!hasTtsCredentials()) {
    return json({ error: "語音服務未設定。", reason: "not_configured" }, 503);
  }

  const verdict = rateLimit(clientIp(request.headers));
  if (!verdict.ok) {
    return json({ error: "請稍等一下再試。", reason: verdict.reason }, 429);
  }

  let text: unknown;
  try {
    ({ text } = (await request.json()) as { text?: unknown });
  } catch {
    return json({ error: "請求格式錯誤。" }, 400);
  }

  if (typeof text !== "string" || !text.trim()) {
    return json({ error: "缺少要合成的文字。" }, 400);
  }
  if (text.length > MAX_TEXT_CHARS) {
    return json({ error: "文字過長。" }, 400);
  }

  try {
    const stream = await synthesizeStream(text.trim());
    // 原封不動轉給瀏覽器。⚠️ 不要在這裡收集成完整 buffer 再回——
    // 那等於把串流退化回等整包，12.9 秒的延遲就是這樣來的。
    return new Response(stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Audio-Format": "pcm_s16le_24000_mono",
      },
    });
  } catch (error) {
    // 合成失敗不該讓聊天壞掉——前端收到非 200 就靜音顯示文字，答案仍然看得到。
    console.error("[tts] 合成失敗：", error);
    return json({ error: "語音合成失敗。" }, 502);
  }
}
