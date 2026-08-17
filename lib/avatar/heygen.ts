import type { AvatarDriver, AvatarDriverHooks } from "./types";

/**
 * LiveAvatar（前 HeyGen Interactive Avatar）driver。
 *
 * ⚠️ **這是整個 repo 裡唯一一個提到 SDK 的檔案。** 它被 lib/avatar/index.ts 用
 * dynamic import 載入，所以 livekit-client 與它那串 WebRTC 依賴不會進預設 bundle、
 * 也不會在 SSR 期間被求值。要維持這個性質：
 *
 *   - 型別一律用 `import type`（會被 TypeScript 完全抹掉）
 *   - 值只能在函式內 `await import(...)`，**不可以**寫成檔案頂層的 import
 *
 * 這兩條破掉的症狀是 `npm run build` 在 prerender 階段炸 `window is not defined`，
 * 而不是執行期才壞——所以 build 過不過就是這條規則的測試。
 */
import type {
  LiveAvatarSession,
  SessionDisconnectReason,
} from "@heygen/liveavatar-web-sdk";

/** P3 會實作這支 route。回傳形狀跟 lib/avatar-ledger 的 AdmissionResult 對齊。 */
const TOKEN_ENDPOINT = "/api/avatar-token";

interface TokenResponse {
  sessionToken?: string;
  maxSessionSeconds?: number;
  reason?: string;
}

export function createHeygenDriver(hooks: AvatarDriverHooks): AvatarDriver {
  let session: LiveAvatarSession | null = null;
  let prepared = false;
  let preparing = false;
  let dead = false;

  /**
   * ⚠️ 刻意不做 keepAlive 輪詢，雖然 SDK 有 `session.keepAlive()`。
   *
   * 那支的作用是**延長一個正在計費的 session**。在一個開放給不特定大眾的網站上
   * 自動續命，等於把成本上限交給「訪客有沒有關分頁」決定——那正是我們用
   * lib/avatar-ledger 三道閘門要避免的事。
   *
   * 如果實測發現不續命會在單次上限之前就被斷線，那要調的是伺服器端的
   * max_session_duration，不是在客戶端偷偷續命。
   */

  async function fetchToken(): Promise<string> {
    const response = await fetch(TOKEN_ENDPOINT, { method: "POST" });
    const body = (await response.json().catch(() => ({}))) as TokenResponse;

    if (!response.ok || !body.sessionToken) {
      // reason 是給人看的（at_capacity / budget_exhausted / disabled），
      // 呼叫端收到 onFatal 之後會降級成 monogram，使用者仍然有文字聊天可用。
      throw new Error(
        `取得 avatar token 失敗（${response.status}${body.reason ? ` ${body.reason}` : ""}）`
      );
    }
    return body.sessionToken;
  }

  return {
    provider: "heygen",
    needsVideo: true,
    metered: true,
    get audioAvailable() {
      // 聲音跟影像走同一條 WebRTC 軌，attach() 之後就有；
      // 跟 monogram 不同，不存在「這台裝置沒有中文語音」的情況。
      return prepared;
    },

    async prepare(video) {
      // 兩道 guard：prepared 擋重複開，preparing 擋還在飛的那一次。
      // reactStrictMode 會讓 effect 跑兩次，少一道就是開兩個計費 session。
      if (prepared || preparing || dead) return;

      if (!video) {
        // 沒有 <video> 就不要開 session——開了也沒地方畫，純燒錢。
        hooks.onFatal(new Error("heygen driver 需要 <video> 元素，但拿到的是 null"));
        return;
      }

      preparing = true;
      try {
        const [{ LiveAvatarSession, SessionEvent, AgentEventsEnum }, token] =
          await Promise.all([import("@heygen/liveavatar-web-sdk"), fetchToken()]);

        if (dead) return;

        // voiceChat: false ＝ 不要麥克風。
        // 我們的互動在文字層（訪客打字 → RAG），開麥克風只會多要一次權限、
        // 多一個瀏覽器權限彈窗，而且完全用不到。
        const next = new LiveAvatarSession(token, { voiceChat: false });

        // 說話狀態直接用官方事件，不要自己用文字長度估時間——
        // 估的那套在 mock 裡是刻意的假時序，在這裡會跟真實嘴型對不上。
        next.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () =>
          hooks.onSpeakingChange(true)
        );
        next.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () =>
          hooks.onSpeakingChange(false)
        );

        // 斷線一律當成不可恢復：呼叫端會降級回 monogram。
        // 這裡不重連——重連等於重新計費，而且使用者已經看到畫面停住了。
        next.on(SessionEvent.SESSION_DISCONNECTED, (reason: SessionDisconnectReason) => {
          hooks.onSpeakingChange(false);
          if (dead) return;
          hooks.onFatal(new Error(`LiveAvatar session 斷線：${reason}`));
        });

        const streamReady = new Promise<void>((resolve) => {
          next.once(SessionEvent.SESSION_STREAM_READY, () => resolve());
        });

        await next.start();
        if (dead) {
          // prepare 進行中被 destroy 了（切分頁、離開頁面）。
          // 一定要把已經開起來的 session 收掉，否則它會一路計費到伺服器端上限。
          await next.stop().catch(() => {});
          return;
        }

        await streamReady;
        if (dead) {
          await next.stop().catch(() => {});
          return;
        }

        // attach() 會把影像與聲音兩條軌都掛到同一個元素上。
        // <video> 掛載時是 muted，解除靜音由使用者手勢那一側處理。
        next.attach(video);

        session = next;
        prepared = true;
      } catch (error) {
        hooks.onFatal(error instanceof Error ? error : new Error(String(error)));
      } finally {
        preparing = false;
      }
    },

    push() {
      // 等整段答案才開口，串流中的 delta 一律忽略。
      // 理由不是省事，是 lib/answer-guard 會回收已經送出的文字——
      // 逐句唸的話，被回收的那段已經用她的臉和聲音講出去了。
      // 完整推論見 types.ts 的 speakableAnswer。
    },

    finish(fullText) {
      if (dead || !prepared || !session) return;
      const text = fullText.trim();
      if (!text) return;

      // ⚠️ 必須先 interrupt。`repeat` 的語意是**排隊**不是打斷——
      // 官方文件原文是「Adds audio to the avatar's playback buffer」。
      // 訪客連續送問題時，少了這一行她會把上一題講完才開始這一題。
      session.interrupt();
      session.repeat(text);
    },

    stop() {
      if (dead || !session) return;
      session.interrupt();
      hooks.onSpeakingChange(false);
    },

    async destroy() {
      dead = true;
      prepared = false;
      const current = session;
      session = null;
      if (!current) return;
      // 收不掉也不能丟例外出去；伺服器端的 max_session_duration 是最後防線。
      await current.stop().catch((error) => {
        console.error("[avatar] LiveAvatar session 關閉失敗：", error);
      });
    },
  };
}
