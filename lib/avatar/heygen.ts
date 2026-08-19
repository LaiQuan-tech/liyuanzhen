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

/** 合成端點。回**串流的裸 PCM**（16-bit / 24kHz / 單聲道），不是 JSON。 */
const TTS_ENDPOINT = "/api/tts";

/**
 * ⚠️ SDK v0.0.18 的缺口：官方 LITE 協定有 `agent.speak_end` 用來標示一段話結束，
 * 但 SDK 的 `CommandEventsEnum` **沒有**這個事件，也沒有對應的方法。
 *
 * 後果是 `avatar.speak_ended` 有可能永遠不回來，那樣 UI 會卡在「回答中」，
 * 而且「停止」按鈕會一直亮著——跟 Phase 0 修掉的那個狀態機死鎖是同一種症狀。
 *
 * 所以這裡用「音訊實際長度 ＋ 緩衝」當保險。它只負責把狀態收乾淨，
 * 不影響聲音本身；真的收到 speak_ended 就以事件為準，這條保險會被取消。
 */
const SPEAK_FALLBACK_GRACE_MS = 2_000;

/**
 * 合成期間的保險上限。這條只在「提前報說話中」到「算出真實音訊長度」之間有效，
 * 正常情況下兩秒內就會被真實長度的 timeout 取代。
 * 存在的意義是：TTS 整個掛掉時，UI 不會永遠卡在「回答中」。
 */
const SPEAK_STARTUP_TIMEOUT_MS = 20_000;

/** PCM 16-bit 24kHz 單聲道：24000 × 2 ＝ 每秒 48000 bytes */
const BYTES_PER_SECOND = 48_000;
/** 官方建議每塊約 1 秒，遠低於 1 MB 的封包上限 */
const CHUNK_BYTES = BYTES_PER_SECOND;

/**
 * Uint8Array → base64。分段處理而不是一次 spread——
 * 一秒的音訊是 48000 個位元組，`String.fromCharCode(...arr)` 會爆 call stack。
 */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const STEP = 8192;
  for (let i = 0; i < bytes.length; i += STEP) {
    const slice = bytes.subarray(i, i + STEP);
    for (let j = 0; j < slice.length; j++) binary += String.fromCharCode(slice[j]);
  }
  return btoa(binary);
}

export function createHeygenDriver(hooks: AvatarDriverHooks): AvatarDriver {
  let session: LiveAvatarSession | null = null;
  let prepared = false;
  let preparing = false;
  let dead = false;
  let speakingFallback: ReturnType<typeof setTimeout> | null = null;

  /**
   * 連線還沒建立完就送到的答案，先擱在這裡，等 prepare() 成功再說出來。
   *
   * ⚠️ 這不是最佳化，是一個**必要**的修正。實測（2026-08-19 正式站）：
   *   prepare()：/api/avatar-token 0.9 秒 ＋ sessions/start 3.2 秒 ＋ 串流就緒
   *              ＝ 約 5～8 秒
   *   一輪問答：/api/stt 1.5～2.5 秒 ＋ /api/chat 0.5～3.6 秒 ＝ 約 2～6 秒
   *
   * 兩者在**第一題**必然交錯：答案幾乎一定比連線先到。舊版的 finish() 寫
   * `if (dead || !prepared || !session) return;`，於是第一題的答案被無聲丟棄——
   * 訪客按住、講完、放開，文字出現了，她卻一個字都沒說。第二題之後才正常。
   * 使用者回報的「說話沒有反應」就是這個，跟麥克風、跟靜音門檻都無關。
   *
   * 只留最後一則：連續問的時候，舊的那則已經沒有意義了。
   */
  let pendingSpeech: string | null = null;

  function clearSpeakingFallback() {
    if (speakingFallback !== null) {
      clearTimeout(speakingFallback);
      speakingFallback = null;
    }
  }

  /**
   * 取得克隆語音並逐塊送進 avatar 的播放緩衝。
   *
   * ⚠️ 只有 LITE mode 有 `repeatAudio`——它需要 SDK 持有的那條 WebSocket，
   * FULL mode 沒有，呼叫會丟例外。所以先看 `session.mode`，
   * FULL 就直接走內建語音（那邊的聲音是在 session 設定裡指定的）。
   */
  async function speakWithClonedVoice(
    active: LiveAvatarSession,
    text: string
  ): Promise<void> {
    if (active.mode !== "LITE") {
      active.repeat(text);
      return;
    }

    // ⚠️ 這裡就先報「說話中」，不要等 AVATAR_SPEAK_STARTED。
    //
    // 實測：/api/chat 結束到她真的出聲之間有 2.7 秒，那段時間 busy 已經是 false、
    // speaking 還是 false，deriveAvatarState 因此回 idle——畫面顯示「線上・可語音朗讀」，
    // 使用者看到答案文字出現、她卻一臉閒著不動。那是 bug 不是延遲。
    //
    // 提前報的代價是「回答中」會比實際出聲早兩秒出現，而那正好是使用者的預期。
    // 保險 timeout 先給一個寬鬆值，等算出真實音訊長度再換掉。
    hooks.onSpeakingChange(true);
    clearSpeakingFallback();
    speakingFallback = setTimeout(() => {
      speakingFallback = null;
      hooks.onSpeakingChange(false);
    }, SPEAK_STARTUP_TIMEOUT_MS);

    const response = await fetch(TTS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok || !response.body) throw new Error(`TTS ${response.status}`);

    // 邊收邊送。每收滿約一秒就丟一塊進播放緩衝，她在講第一塊時後面的還在傳——
    // 這是把「送出問題到她開口」從 12.9 秒壓下來的關鍵，不要改回等整包。
    const reader = response.body.getReader();
    let pending = new Uint8Array(0);
    let totalBytes = 0;

    const flush = (bytes: Uint8Array) => {
      if (dead || !bytes.length) return;
      active.repeatAudio(toBase64(bytes));
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (dead) {
        reader.cancel().catch(() => {});
        return;
      }
      if (value?.length) {
        const merged = new Uint8Array(pending.length + value.length);
        merged.set(pending);
        merged.set(value, pending.length);
        pending = merged;
        totalBytes += value.length;

        while (pending.length >= CHUNK_BYTES) {
          flush(pending.subarray(0, CHUNK_BYTES));
          pending = pending.subarray(CHUNK_BYTES);
        }
      }
      if (done) break;
    }
    // 最後不足一秒的殘塊也要送，否則句尾會被吃掉。
    // ⚠️ 一定要對齊到偶數 byte——切在 16-bit 取樣中間會讓整塊變雜訊。
    flush(pending.subarray(0, pending.length - (pending.length % 2)));

    const seconds = totalBytes / BYTES_PER_SECOND;

    clearSpeakingFallback();
    speakingFallback = setTimeout(
      () => {
        speakingFallback = null;
        hooks.onSpeakingChange(false);
      },
      seconds * 1000 + SPEAK_FALLBACK_GRACE_MS
    );
  }

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

  /**
   * 真正發聲的那一段。finish() 與 prepare() 的補說都走這裡，
   * 兩條路必須完全一樣——否則排隊補說的那一則會少掉 interrupt 或少掉降級。
   */
  function speakNow(active: LiveAvatarSession, text: string): void {
    // ⚠️ 必須先 interrupt。speak 的語意是**排隊**不是打斷——
    // 官方文件原文是「Adds audio to the avatar's playback buffer」。
    // 訪客連續送問題時，少了這一行她會把上一題講完才開始這一題。
    active.interrupt();
    clearSpeakingFallback();

    // 用她的克隆聲音。失敗時退回 HeyGen 內建語音，寧可聲音不像，
    // 也不要整個回答變成無聲——文字使用者已經看到了。
    speakWithClonedVoice(active, text).catch((error) => {
      console.error("[avatar] 克隆語音失敗，改用內建語音：", error);
      if (!dead && session) session.repeat(text);
    });
  }

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

    // 把伺服器說的上限往上報。⚠️ 不要讓呼叫端自己猜一個數字——
    // 猜大了她會在對話中途無預警消失，猜小了則是白白浪費已經付錢的時間。
    if (typeof body.maxSessionSeconds === "number" && body.maxSessionSeconds > 0) {
      hooks.onSessionLimit?.(body.maxSessionSeconds);
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
        next.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
          hooks.onSpeakingChange(true);
        });
        next.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
          // 真的收到事件就以事件為準，取消那條以時間估算的保險
          clearSpeakingFallback();
          hooks.onSpeakingChange(false);
        });

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

        // 連線期間送進來的答案在這裡補說。⚠️ 這一段不可以拿掉——
        // 沒有它，每次開頁之後的第一題都是無聲的。
        const queued = pendingSpeech;
        pendingSpeech = null;
        if (queued) speakNow(next, queued);
      } catch (error) {
        // 連不上就沒有人能說那句話了。留著只會在下一次 prepare 成功時
        // 突然講一段舊答案。
        pendingSpeech = null;
        hooks.onFatal(error instanceof Error ? error : new Error(String(error)));
      } finally {
        preparing = false;
      }
    },

    push() {
      // 等整段答案才開口，串流中的 delta 一律忽略。
      // 理由不是省事，是 lib/answer-guard 命中封鎖清單時會停止輸出並追加婉拒句，
      // 而那個判定要等到後面才發生——逐句唸的話，被判定為不該說的那段
      // 已經用她的臉和聲音講出去了。完整推論見 types.ts 的 speakableAnswer。
    },

    finish(fullText) {
      if (dead) return;
      const text = fullText.trim();
      if (!text) return;

      // ⚠️ 還沒接通就把答案丟掉，等於第一題永遠不會有聲音。見 pendingSpeech 的說明。
      // 只在「正在連線」時排隊：prepare() 根本沒被呼叫過的話沒有東西可以等，
      // 排了也只會在很久以後憑空冒出一句話。
      if (!prepared || !session) {
        if (preparing) pendingSpeech = text;
        return;
      }

      speakNow(session, text);
    },

    stop() {
      // ⚠️ 排隊中的那則也要丟掉，而且要在 `!session` 的提前 return 之前做。
      // 使用者按下按鈕就是要打斷；讓一則幾秒前的答案在連線完成的瞬間才冒出來，
      // 比她不出聲更難理解。
      pendingSpeech = null;
      if (dead || !session) return;
      clearSpeakingFallback();
      session.interrupt();
      hooks.onSpeakingChange(false);
    },

    async destroy() {
      dead = true;
      prepared = false;
      pendingSpeech = null;
      clearSpeakingFallback();
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
