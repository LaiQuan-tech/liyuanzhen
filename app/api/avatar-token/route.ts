import type { NextRequest } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { checkAdmission, openSession, readLimits } from "@/lib/avatar-ledger";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 20;

/**
 * 鑄一張 LiveAvatar session token 給瀏覽器。
 *
 * ⚠️ **這是整個網站最貴的一支端點。** 每次成功回應都會開一個計費的串流 session。
 * 四道閘門依序過：Origin → 每 IP 限流 → 帳本（killswitch／月預算／並發）→ LiveAvatar。
 * 真正擋得住腳本的只有帳本那一道（跨 Vercel 實例共用計數），前兩道是減速丘。
 */

const API_BASE = "https://api.liveavatar.com";

/**
 * LITE mode：音訊由我們自己合成（/api/tts 走 ElevenLabs 的克隆聲音）。
 * 選 LITE 不是為了省錢，是因為她的聲音只有這條路能用——
 * FULL mode 的 TTS 由 LiveAvatar 那側決定，我們的 voice_id 進不去。
 */
const MODE = "LITE";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function originAllowed(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

/**
 * ⚠️ 存雜湊不存原始 IP。這是開放給不特定大眾的公開網站，
 * 帳本只需要「同一個來源開了幾個」，不需要知道那是誰。
 */
function hashClient(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

/**
 * 從 session token 取出 LiveAvatar 的 session_id。
 *
 * ⚠️ 刻意不驗簽章——這張 token 是我們自己剛剛從 LiveAvatar 拿到的，
 * 不是外部輸入，這裡只是把裡面已經有的欄位讀出來。
 * 解不出來就回 null，呼叫端退回自產 UUID（帳本仍然算得對，只是無法對帳）。
 */
function sessionIdFromToken(token: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    );
    return typeof payload.session_id === "string" ? payload.session_id : null;
  } catch {
    return null;
  }
}

/** at_capacity 是唯一「等一下就會好」的拒絕，UI 要顯示排隊而不是錯誤。 */
const DENIAL_MESSAGE: Record<string, string> = {
  at_capacity: "現在同時對話的人比較多，請稍等一下再開啟語音。",
  budget_exhausted: "本月的語音額度已用完，仍然可以用文字對話。",
  disabled: "語音功能目前未開啟。",
};

export async function POST(request: NextRequest) {
  if (!originAllowed(request)) {
    return json({ error: "請從本網站發起請求。" }, 403);
  }

  const apiKey = process.env.LIVEAVATAR_API_KEY;
  const avatarId = process.env.LIVEAVATAR_AVATAR_ID;
  if (!apiKey || !avatarId) {
    return json({ error: "虛擬人未設定。", reason: "not_configured" }, 503);
  }

  const ip = clientIp(request.headers);
  const verdict = rateLimit(ip);
  if (!verdict.ok) {
    return json({ error: "請稍等一下再試。", reason: verdict.reason }, 429);
  }

  // 帳本：killswitch → 月預算 → 並發。順序有意義，見 lib/avatar-ledger/types.ts。
  let admission;
  try {
    admission = await checkAdmission();
  } catch (error) {
    // 帳本壞掉時**拒發**而不是放行——不然成本上限就沒有了。
    console.error("[avatar-token] 帳本查詢失敗，保守拒發：", error);
    return json({ error: "語音功能暫時無法使用。", reason: "disabled" }, 503);
  }

  if (!admission.admit) {
    return json(
      {
        error: DENIAL_MESSAGE[admission.reason] ?? "語音功能目前無法使用。",
        reason: admission.reason,
        queueAhead: admission.queueAhead,
      },
      admission.reason === "at_capacity" ? 429 : 503
    );
  }

  const maxSessionSeconds = admission.maxSessionSeconds;

  // session_id 在鑄 token 的回應裡就拿得到（編在 JWT payload），
  // 所以帳本用 LiveAvatar 真正的 id 當主鍵——重複開同一個 session 會被主鍵擋掉，
  // 而且事後跟 LiveAvatar 的用量對帳時對得起來。

  try {
    const response = await fetch(`${API_BASE}/v1/sessions/token`, {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: MODE,
        avatar_id: avatarId,
        max_session_duration: maxSessionSeconds,
        is_sandbox: process.env.LIVEAVATAR_SANDBOX === "true",
      }),
    });

    const body = await response.json();
    const sessionToken = body?.data?.session_token;
    if (!response.ok || !sessionToken) {
      console.error(
        "[avatar-token] LiveAvatar 鑄 token 失敗",
        response.status,
        JSON.stringify(body).slice(0, 300)
      );
      return json({ error: "語音功能暫時無法使用。" }, 502);
    }

    const sessionId = sessionIdFromToken(sessionToken) ?? randomUUID();

    // 先記帳再回應。順序不能反——如果先回應再記帳而記帳失敗，
    // 就會有一個在計費卻不在帳本裡的 session，並發水位從此永久低估。
    await openSession(sessionId, hashClient(ip), maxSessionSeconds);

    return json({ sessionToken, maxSessionSeconds });
  } catch (error) {
    console.error("[avatar-token] 例外：", error);
    return json({ error: "語音功能暫時無法使用。" }, 502);
  }
}
