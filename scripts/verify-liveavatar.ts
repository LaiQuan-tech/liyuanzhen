/**
 * LiveAvatar sandbox 驗證：一次回答三個還沒有答案的架構問題。
 *
 * 用法（拿到 API key 之後）：
 *   1. 把 LIVEAVATAR_API_KEY=... 寫進 .env.local
 *   2. npm run verify:liveavatar
 *
 * ⚠️ sandbox 模式不扣 credits，Free 方案就能跑完整支。
 *    這是整個計畫裡投報率最高的 30 分鐘——它決定要不要自己養一個 LiveKit room，
 *    而那是一整個元件、一筆帳單、一個故障點的差別。
 *
 * 要回答的三題：
 *
 * Q1 訪客拿到的 token 能不能發布東西進 room？
 *    如果 canPublish / canPublishData 都是 false，那訪客就沒有任何管道
 *    往 room 裡塞東西，我們可以直接用 LiveAvatar 託管的 room，
 *    LiveKit 那條線整條歸零。
 *    如果是 true，才需要自己開 room 並簽一個限制過的 token。
 *
 * Q2 ws_url 是不是真的只有 LITE 模式才有？
 *    ws_url 是「叫她用任意音訊開口」的控制通道。官方 schema 註明
 *    「Custom Mode only」。FULL 模式若確實沒有這個欄位，那 FULL 在
 *    注入風險上就是結構性地更安全——不是靠我們守，是根本不存在。
 *
 * Q3 max_session_duration 是不是真的能在鑄 token 時就釘死？
 *    如果可以，單次時長上限就從「我們自己在瀏覽器裡數秒數」升級成
 *    「伺服器端強制」。前者訪客改個 JS 就能繞過，後者不行。
 *    這會直接簡化 lib/avatar-ledger 的第三道閘門。
 */

const API_BASE = "https://api.liveavatar.com";

/**
 * ⚠️ sandbox 只開放一個 avatar（官方文件明列的 Wayne），其他 avatar 一律回
 * 「This avatar is not supported in sandbox mode」400。不要換成 studio avatar 的 id。
 * 另外 sandbox 的 session 約一分鐘就會自己結束，那是刻意的，不是我們的 bug。
 */
const SANDBOX_AVATAR_ID =
  process.env.LIVEAVATAR_TEST_AVATAR_ID ?? "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a";

/** 跟 lib/avatar-ledger 的預設值對齊，順便驗證這個數字會不會被打回票 */
const MAX_SESSION_SECONDS = 180;

type Mode = "LITE" | "FULL";

interface StartSessionData {
  session_id: string;
  livekit_url: string;
  livekit_client_token: string;
  livekit_agent_token?: string;
  max_session_duration?: number;
  ws_url?: string;
}

function requireKey(): string {
  const key = process.env.LIVEAVATAR_API_KEY;
  if (!key) {
    console.error(
      "缺 LIVEAVATAR_API_KEY。到 app.liveavatar.com → Developers 拿，寫進 .env.local。\n" +
        "⚠️ 那是 liveavatar.com 的 key，不是 heygen.com 的——兩者計費池分開，混用會 401。"
    );
    process.exit(1);
  }
  return key;
}

/**
 * 解 JWT 的 payload。
 * ⚠️ 這裡刻意不驗簽章——我們不是要信任它，是要**讀它宣告了什麼權限**。
 * 驗簽需要 LiveKit 的 secret，而我們正好沒有（那就是重點）。
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * ✅ Q3 已由這裡證實：`max_session_duration` 是**伺服器端強制**的。
 *
 * 送 180 秒到 Free／sandbox 會被 400 打回來，訊息是
 * 「max_session_duration (180s) exceeds the maximum allowed (60s)」。
 * 這正是我們要的行為——上限不是我們自律，是對方拒收。
 *
 * 這個函式把「被打回來的上限」解出來，好讓驗證能繼續跑完 Q1／Q2。
 */
function parseAllowedMax(message: string): number | null {
  const match = message.match(/maximum allowed \((\d+)s\)/);
  return match ? Number(match[1]) : null;
}

async function mintToken(
  apiKey: string,
  mode: Mode,
  maxSeconds = MAX_SESSION_SECONDS
): Promise<string> {
  const body: Record<string, unknown> = {
    mode,
    avatar_id: SANDBOX_AVATAR_ID,
    is_sandbox: true,
    max_session_duration: maxSeconds,
  };

  // FULL 一定要帶 avatar_persona 或 voice_agent 其中「剛好一個」，兩個都不給會 422。
  // 這裡帶最小的 avatar_persona：voice_id 留空＝用 avatar 的預設聲音。
  // （avatar_persona 官方標記 deprecated，正式上線要改用 voice_agent；
  //   但這支只是要探 token 權限，用最小可行的就好。）
  if (mode === "FULL") body.avatar_persona = { language: "zh" };

  const response = await fetch(`${API_BASE}/v1/sessions/token`, {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const result = await response.json();
  if (!response.ok) {
    const allowed = parseAllowedMax(String(result?.message ?? ""));
    if (allowed && allowed < maxSeconds) {
      console.log(
        `   [Q3] ✅ 伺服器端強制生效：送 ${maxSeconds} 秒被拒，上限是 ${allowed} 秒。` +
          `\n        改用 ${allowed} 秒重試，繼續驗 Q1／Q2。`
      );
      return mintToken(apiKey, mode, allowed);
    }
    throw new Error(
      `鑄 token 失敗 ${response.status}：${JSON.stringify(result).slice(0, 400)}`
    );
  }
  const token = result?.data?.session_token;
  if (!token) {
    throw new Error(`回應裡沒有 session_token：${JSON.stringify(result).slice(0, 400)}`);
  }
  return token;
}

async function startSession(sessionToken: string): Promise<StartSessionData> {
  const response = await fetch(`${API_BASE}/v1/sessions/start`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `開 session 失敗 ${response.status}：${JSON.stringify(body).slice(0, 400)}`
    );
  }
  return body.data as StartSessionData;
}

async function stopSession(sessionToken: string): Promise<void> {
  // sandbox 不扣 credits，收不乾淨也不會痛，所以失敗只記錄不中斷。
  try {
    const response = await fetch(`${API_BASE}/v1/sessions/stop`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    console.log(`   收尾 stop：${response.status}`);
  } catch (error) {
    console.log(`   收尾 stop 失敗（sandbox 不計費，可忽略）：${String(error)}`);
  }
}

async function probe(apiKey: string, mode: Mode) {
  console.log(`\n═══ ${mode} mode ═══`);

  const sessionToken = await mintToken(apiKey, mode);
  const data = await startSession(sessionToken);

  console.log(`   session_id            ${data.session_id}`);
  console.log(`   livekit_url           ${data.livekit_url}`);
  console.log(`   有 agent token        ${data.livekit_agent_token ? "有" : "沒有"}`);

  // ── Q3 ──────────────────────────────────────────────
  const enforced = data.max_session_duration;
  console.log(
    `\n   [Q3] 伺服器端單次時長上限：${enforced ?? "（回應沒帶這個欄位）"}` +
      (enforced === MAX_SESSION_SECONDS
        ? `  ✅ 我們送的 ${MAX_SESSION_SECONDS} 秒被接受了`
        : enforced
          ? `  ⚠️ 跟我們送的 ${MAX_SESSION_SECONDS} 秒不一樣，以伺服器為準`
          : "  ⚠️ 沒帶回來，不能假設有被強制")
  );

  // ── Q2 ──────────────────────────────────────────────
  console.log(
    `\n   [Q2] ws_url：${data.ws_url ? "有" : "沒有"}` +
      (mode === "FULL"
        ? data.ws_url
          ? "  ⚠️ FULL 竟然也給了控制通道，注入面沒有變小"
          : "  ✅ FULL 沒有控制通道，注入風險結構性消失"
        : data.ws_url
          ? "  ← 這就是必須留在伺服器端、絕不能給瀏覽器的那個東西"
          : "  ⚠️ LITE 沒有 ws_url？那就沒辦法送我們自己的音訊了，要重查")
  );

  // ── Q1 ──────────────────────────────────────────────
  const payload = decodeJwtPayload(data.livekit_client_token);
  const grants = (payload?.video ?? null) as Record<string, unknown> | null;

  console.log("\n   [Q1] 訪客 token 的 video grants：");
  if (!grants) {
    console.log("      ⚠️ 解不出 video grant，要人工看一下 payload：");
    console.log("      " + JSON.stringify(payload).slice(0, 600));
    return;
  }

  for (const key of [
    "room",
    "roomJoin",
    "canSubscribe",
    "canPublish",
    "canPublishData",
    "canUpdateOwnMetadata",
  ]) {
    if (key in grants) console.log(`      ${key.padEnd(22)} ${grants[key]}`);
  }

  const canInject = grants.canPublish === true || grants.canPublishData === true;
  console.log(
    canInject
      ? "\n      ⚠️ 訪客可以往 room 裡發布東西 → 需要自己開 LiveKit room 並簽限制過的 token"
      : "\n      ✅ 訪客只能訂閱、不能發布 → 可以直接用 LiveAvatar 託管的 room，" +
          "\n         LiveKit 那條線可以整條拿掉（少一個元件、少一筆帳單、少一個故障點）"
  );

  await stopSession(sessionToken);
}

async function main() {
  const apiKey = requireKey();
  console.log(`借測用 avatar_id：${SANDBOX_AVATAR_ID}（sandbox，不扣 credits）`);

  for (const mode of ["LITE", "FULL"] as Mode[]) {
    try {
      await probe(apiKey, mode);
    } catch (error) {
      // 一個模式掛掉不該擋住另一個——FULL 可能因為還沒設 voice_agent 而失敗，
      // 但 LITE 的結論本身就有價值。
      console.error(`\n═══ ${mode} mode ═══\n   ✗ ${String(error)}`);
    }
  }

  console.log(
    "\n把上面三題的結果貼回對話，我就能把附錄 D-8 的架構結論定案。\n" +
      "⚠️ 不要把 API key 本身貼進來。"
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// ⚠️ 不要刪這一行。這支檔案沒有任何 import，少了它 TypeScript 會把整份當成
// **全域腳本**而不是 module，於是 `main()` 跟 scripts/ 底下其他腳本的 `main()`
// 撞成 TS2393，而且症狀是 `npm run build` 失敗——離現場很遠，很難聯想。
export {};
