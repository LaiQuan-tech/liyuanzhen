import type { AvatarDriver, AvatarDriverHooks } from "./types";
import { openSpeechStream } from "./speech-stream";
import { trace } from "@/lib/trace";

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
  sessionId?: string;
  reason?: string;
}

/**
 * ⚠️ SDK v0.0.18 的缺口：官方 LITE 協定有 `agent.speak_end` 用來標示一段話結束，
 * 但 SDK 的 `CommandEventsEnum` **沒有**這個事件，也沒有對應的方法。
 *
 * 後果是 `avatar.speak_ended` 有可能永遠不回來，那樣 UI 會卡在「回答中」，
 * 而且「停止」按鈕會一直亮著——跟 Phase 0 修掉的那個狀態機死鎖是同一種症狀。
 *
 * 所以這裡用「估計講完的時間 ＋ 緩衝」當保險（估法見 speak() 收尾的 playbackEnd）。它只負責把狀態收乾淨，
 * 不影響聲音本身；真的收到 speak_ended 就以事件為準，這條保險會被取消。
 * （例外：後段失敗等著回報的那一則，回報時間只看這條估計，見 Utterance.failed。）
 *
 * ⚠️ 這個寬限要蓋得住「我們送出第一塊」到「她真的開口」之間 avatar 那一側的延遲——
 * 講完時間是從第一塊送出的時刻起算的，不是從她出聲起算。
 */
const SPEAK_FALLBACK_GRACE_MS = 2_000;

/**
 * 合成期間的保險：**這麼久沒有收到新的音訊**，就把「回答中」收掉。
 * 存在的意義是：TTS 整個掛掉時，UI 不會永遠卡在「回答中」。
 *
 * 🔴 每收到一塊就重新計時，不是從開始算 20 秒（2026-09-29 修，重現在 heygen.test.ts 的 A7）。
 * 舊版只在「整條串流讀完」才換成真實長度——串流要讀超過 20 秒時（ElevenLabs 約 2.25 倍實時，
 * 單段 >~185 字就會；長答案切段之後每一段都要等上一段收完才去要，一定會），
 * 她還在講，畫面就報「講完了」，LiveStage 因此不會在訪客按下按鈕時打斷她，她會蓋著錄音講下去。
 * 串流收完之後改用「估計講完的時間＋寬限」那條（SPEAK_FALLBACK_GRACE_MS）。
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 一則答案（一次開口）。每一則一個，被打斷就整個丟掉——照 monogram.ts 的 Utterance 寫法。
 *
 * 🔴 存在的理由（2026-09-29 查證，重現與守門測試在 heygen.test.ts 的 A1–A6）：
 * 舊版的 stop() 只 `session.interrupt()`，還在讀的 /api/tts 串流照讀、照 repeatAudio——
 * 訪客按下去打斷，她停一下又從後面接著講（interrupt 清掉的只是當下已經排的）；
 * 回應還沒到就按，整段稍後照講、蓋在訪客的錄音上；stop 之後馬上來下一題，
 * 兩則的塊交錯送進同一個播放緩衝（B,A,B,A）；被打斷的那一則後來出錯，
 * 還會對**新的**一則報「聲音沒出來」、清掉新一則的保險。
 * 所以：每一則自己一個 AbortController（請求與重試一起停），而每一個 await 回來、
 * 每一塊送出之前，都先問「我還是不是 current」——過期的不送塊、不報任何事、不碰計時器。
 */
interface Utterance {
  /** 這一則所有請求共用（各段依序要，同一時間只有一個在飛）。打斷時 abort */
  abort: AbortController;
  /** 正在讀的那條串流。打斷時直接 cancel——不必等下一塊到了才發現自己過期 */
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  /** 見 SPEAK_STARTUP_TIMEOUT_MS。串流收完就撤掉 */
  watchdog: ReturnType<typeof setTimeout> | null;
  /** 串流收完之後，到估計她講完（＋寬限）的那一刻（見 speak() 收尾的 playbackEnd） */
  endTimer: ReturnType<typeof setTimeout> | null;
  /** 串流整條讀完、塊都送進 avatar 了——剩下的只是等她講完 */
  streamed: boolean;
  /**
   * 後面某一段沒拿到／讀到一半斷掉。已經送出去的照講，**估計講完時**（endTimer）才回報 onSpeechFailed。
   * ⚠️ 這個回報不可以被 AVATAR_SPEAK_ENDED 清掉：那個事件什麼時候來、來幾次，SDK 沒有保證。
   * ⚠️ 等回報的這段期間說話狀態也要撐著（speak_ended 來了也不收），理由見 AVATAR_SPEAK_ENDED 的處理。
   */
  failed: boolean;
}

export function createHeygenDriver(hooks: AvatarDriverHooks): AvatarDriver {
  let session: LiveAvatarSession | null = null;
  let prepared = false;
  let preparing = false;
  let dead = false;
  /**
   * 已經報過 onFatal 了。🔴 每個 driver 最多報一次：start() 失敗時 SDK 會**先**發
   * SESSION_DISCONNECTED **再** throw，兩條路都會走到回報——舊版因此同一次失敗報兩次，
   * 呼叫端如果在第一次就換上新的 driver，第二次會把新的那個當成失效的收掉。
   */
  let fatalReported = false;
  /** 最後一次回報給呼叫端的說話狀態。只在變化時回報；fatal 時靠它判斷「聲音是不是還在播」 */
  let speaking = false;
  /** 正在進行的那一則：在要語音、在送塊、或送完了在等她講完。null ＝ 手上沒有東西 */
  let current: Utterance | null = null;

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

  function setSpeaking(next: boolean) {
    if (speaking === next) return;
    speaking = next;
    hooks.onSpeakingChange(next);
  }

  function clearTimers(u: Utterance) {
    if (u.watchdog !== null) clearTimeout(u.watchdog);
    if (u.endTimer !== null) clearTimeout(u.endTimer);
    u.watchdog = null;
    u.endTimer = null;
  }

  /**
   * 立刻丟掉目前這一則，**不回報任何事**（被打斷不是失敗；說話狀態由呼叫的人決定要不要收）。
   *
   * 三件事缺一不可：
   * - current 先清成 null：abort 會讓 speak() 的 await 醒來，它靠 `current !== u` 認出自己過期，
   *   才不會把「被取消」誤報成「聲音沒出來」。
   * - abort：還在飛的 /api/tts 與它的重試一起停（A2、A4）。
   * - cancel 正在讀的串流：已經到手的回應不一定理會 abort，不 cancel 的話要等下一塊到了才停。
   */
  function halt() {
    const u = current;
    current = null;
    if (!u) return;
    clearTimers(u);
    u.abort.abort();
    u.reader?.cancel().catch(() => {});
    u.reader = null;
  }

  /** 這一則結束了（講完或失敗）。已經被換掉的舊一則呼叫進來一律忽略。 */
  function settle(u: Utterance, failed: boolean) {
    if (current !== u) return;
    current = null;
    clearTimers(u);
    setSpeaking(false);
    if (failed) hooks.onSpeechFailed?.();
  }

  /** 見 SPEAK_STARTUP_TIMEOUT_MS：送出時與每收到一塊時重新計時 */
  function armWatchdog(u: Utterance) {
    if (current !== u) return;
    if (u.watchdog !== null) clearTimeout(u.watchdog);
    u.watchdog = setTimeout(() => {
      u.watchdog = null;
      if (current !== u) return;
      // 只把「回答中」收掉。請求本身不動（舊行為）：它之後真的到了，她照樣會開口，
      // 真的失敗了也照樣會回報。
      setSpeaking(false);
    }, SPEAK_STARTUP_TIMEOUT_MS);
  }

  /**
   * 回報「這個 driver 死了」。🔴 所有 onFatal 都必須經過這裡（2026-09-29）：
   *
   * - 每個 driver 最多一次；destroy() 之後一律不報（呼叫端已經不要這個 driver 了——
   *   切分頁收掉之後才失敗的 prepare 不可以把畫面降級）。
   * - 它收下卻還沒送達的答案（排隊中、正在要語音或送塊、送完了她還在講）要**先**
   *   onSpeechFailed 一次再報 onFatal：呼叫端降級之後不會補說那一則，舊版在這裡什麼都不講，
   *   訪客看到的就是「講到一半斷掉」或「答案出來了她不出聲」，零解釋。
   * - 順序固定：說話狀態收掉 → onSpeechFailed → onFatal。
   */
  function reportFatal(error: Error) {
    if (dead || fatalReported) return;
    fatalReported = true;
    const undelivered = pendingSpeech !== null || current !== null || speaking;
    pendingSpeech = null;
    halt();
    setSpeaking(false);
    if (undelivered) {
      trace("這一則沒送到就斷了", error.message, "error");
      hooks.onSpeechFailed?.();
    }
    hooks.onFatal(error);
  }

  /**
   * 取得克隆語音並逐塊送進 avatar 的播放緩衝。只給 LITE 用（見 speakNow）。
   *
   * 切段、重試、後段失敗的語意都在 lib/avatar/speech-stream.ts（跟 /live4 共用），
   * 重試策略的正本在 lib/avatar/tts-request.ts（跟 /chat 朗讀的 monogram 共用）。
   */
  async function speak(active: LiveAvatarSession, u: Utterance, text: string): Promise<void> {
    // ⚠️ 這裡就先報「說話中」，不要等 AVATAR_SPEAK_STARTED。
    //
    // 實測：/api/chat 結束到她真的出聲之間有 2.7 秒，那段時間 busy 已經是 false、
    // speaking 還是 false，deriveAvatarState 因此回 idle——畫面顯示「線上・可語音朗讀」，
    // 使用者看到答案文字出現、她卻一臉閒著不動。那是 bug 不是延遲。
    // LiveStage 也靠這個 true 才會在訪客按下按鈕時呼叫 stop()——延後報等於那段時間打斷不了她。
    //
    // 提前報的代價是「回答中」會比實際出聲早兩秒出現，而那正好是使用者的預期。
    setSpeaking(true);
    armWatchdog(u);

    trace("向 /api/tts 要克隆語音", `${text.length} 字`);
    const stream = await openSpeechStream(text, {
      signal: u.abort.signal,
      // destroy 之後不再等下一次重試（destroy 也會 abort，這條是多一道保險）
      isCancelled: () => dead,
      onChunk: () => armWatchdog(u),
      onSegmentFailed: (index, total, error) => {
        if (current !== u) return;
        u.failed = true;
        trace(
          "克隆語音中途斷掉",
          `第 ${index + 1}/${total} 段：${describe(error)}（已經送出去的照講，講完再回報）`,
          "error"
        );
      },
    });
    if (dead || current !== u) {
      stream.cancel().catch(() => {});
      return;
    }

    // 邊收邊送。每收滿約一秒就丟一塊進播放緩衝，她在講第一塊時後面的還在傳——
    // 這是把「送出問題到她開口」從 12.9 秒壓下來的關鍵，不要改回等整包。
    // 長答案的各段已經在 openSpeechStream 裡接成一條，這裡看到的就是一條連續的 PCM。
    // （SDK 每次 repeatAudio 各自帶 speak_end、不帶 interrupt，連續送會在播放緩衝裡排隊。）
    const reader = stream.getReader();
    u.reader = reader;
    let pending = new Uint8Array(0);
    /** 真的送進 avatar 播放緩衝的位元組數（她要講多久就看這個） */
    let sentBytes = 0;
    /** 第一塊真的送出去的時刻（Date.now()）：她從這一刻開始講，後面的塊在播放緩衝裡接著排 */
    // ⚠️ 用 `as` 宣告型別：寫成 `let firstFlushAt: number | null = null` 的話 TypeScript 會把它收窄成 null，
    // 看不到 flush() 裡的賦值
    let firstFlushAt = null as number | null;
    /** 最後送出的那一塊有多長（毫秒）。串流比實時慢的時候，講完時間由它決定 */
    let lastChunkMs = 0;

    /** 送一塊進播放緩衝。false ＝ 這一則已經過期（被打斷、斷線），整條停下來 */
    const flush = (bytes: Uint8Array): boolean => {
      if (dead || current !== u) return false;
      if (bytes.length) {
        active.repeatAudio(toBase64(bytes));
        firstFlushAt ??= Date.now();
        sentBytes += bytes.length;
        lastChunkMs = (bytes.length / BYTES_PER_SECOND) * 1000;
      }
      return true;
    };

    for (;;) {
      const { done, value } = await reader.read();
      // ⚠️ 先問身分再看 done：被打斷時 halt() 會 cancel 這條串流，read 回來的正是 done——
      // 不先擋的話，一則已經被丟掉的答案會走到下面的收尾，去碰新一則的狀態（A6）。
      if (dead || current !== u) {
        reader.cancel().catch(() => {});
        return;
      }
      if (value?.length) {
        const merged = new Uint8Array(pending.length + value.length);
        merged.set(pending);
        merged.set(value, pending.length);
        pending = merged;

        while (pending.length >= CHUNK_BYTES) {
          if (!flush(pending.subarray(0, CHUNK_BYTES))) {
            reader.cancel().catch(() => {});
            return;
          }
          pending = pending.subarray(CHUNK_BYTES);
        }
      }
      if (done) break;
    }
    u.reader = null;
    // 最後不足一秒的殘塊也要送，否則句尾會被吃掉。
    // ⚠️ 一定要對齊到偶數 byte——切在 16-bit 取樣中間會讓整塊變雜訊。
    if (!flush(pending.subarray(0, pending.length - (pending.length % 2)))) return;

    u.streamed = true;
    if (u.watchdog !== null) {
      clearTimeout(u.watchdog);
      u.watchdog = null;
    }

    if (sentBytes === 0) {
      // 一個取樣都沒收到（第一段一開始讀就斷、或合成回了空的 200）：沒有東西可以講，
      // 現在就明講——跟 monogram 同一條規則，不可以無聲又零解釋。
      trace("克隆語音一個取樣都沒有", undefined, "error");
      settle(u, true);
      return;
    }

    // 🔴 估她什麼時候講完（2026-09-29 改）。舊版是「串流收完＋整段秒數」，但她從**第一塊送出**就開始講了：
    // 串流比實時快的時候（ElevenLabs 約 2.25 倍，正常情況就是這樣），舊的估法會晚「收完所花的時間」——
    // 10 秒的答案晚 6 秒多、兩段式長答案晚四十幾秒。後段失敗的提示因此掛到下一輪去（那時說話狀態早就收了，
    // 訪客按下一題不會打斷這一則，回報照樣觸發）。
    // - 比實時快：塊在她的播放緩衝裡排隊，講完 ≈ 第一塊送出 ＋ 總長度
    // - 比實時慢：每一塊到的時候上一塊早就講完了，講完 ≈ 現在 ＋ 最後一塊的長度
    // 兩者取晚的。成功與失敗同一套：成功時它是「一直沒等到 speak_ended」的保險，失敗時它就是回報的時間點。
    const now = Date.now();
    const seconds = sentBytes / BYTES_PER_SECOND;
    const playbackEnd = Math.max((firstFlushAt ?? now) + seconds * 1000, now + lastChunkMs);
    trace("語音送進 avatar 播放緩衝", `${seconds.toFixed(1)}s 音訊，估計 ${((playbackEnd - now) / 1000).toFixed(1)}s 後講完`);
    u.endTimer = setTimeout(() => {
      u.endTimer = null;
      settle(u, u.failed);
    }, playbackEnd - now + SPEAK_FALLBACK_GRACE_MS);
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
   * 兩條路必須完全一樣——否則排隊補說的那一則會少掉 interrupt 或少掉打斷處理。
   */
  function speakNow(active: LiveAvatarSession, text: string): void {
    // 上一則（還在要語音、還在送塊、或送完了在等她講完）先整個丟掉。
    // 只靠下面的 interrupt 不夠：它清的是伺服器端已經排的，上一則還在讀的串流會繼續往裡送（A3）。
    halt();

    // ⚠️ 必須先 interrupt。speak 的語意是**排隊**不是打斷——
    // 官方文件原文是「Adds audio to the avatar's playback buffer」。
    // 訪客連續送問題時，少了這一行她會把上一題講完才開始這一題。
    active.interrupt();

    // ⚠️ 只有 LITE mode 有 `repeatAudio`——它需要 SDK 持有的那條 WebSocket，
    // FULL mode 沒有，呼叫會丟例外。所以先看 `session.mode`，
    // FULL 就直接走內建語音（那邊的聲音是在 session 設定裡指定的，說話狀態看事件）。
    if (active.mode !== "LITE") {
      try {
        active.repeat(text);
      } catch (error) {
        trace("內建語音送不出去", describe(error), "error");
        hooks.onSpeechFailed?.();
      }
      return;
    }

    const u: Utterance = {
      abort: new AbortController(),
      reader: null,
      watchdog: null,
      endTimer: null,
      streamed: false,
      failed: false,
    };
    current = u;

    // 用她的克隆聲音。
    speak(active, u, text).catch((error) => {
      // 被打斷（stop、下一則、斷線、destroy）時 current 已經不是 u 了：那不是失敗，什麼都不報
      if (dead || current !== u) return;
      trace("克隆語音失敗", describe(error), "error");

      // ⚠️ 一定要自己把「回答中」收掉（settle 會做）。speak() 一開頭就報了 true，
      // 靠那條 20 秒的保險收，畫面會無聲地寫著「回答中」整整 20 秒。
      //
      // ⚠️ 不要退回 `repeat()`：它只在非 LITE 模式有用。LITE 下指令送得出去、聲音不會出來
      // （實測：console 印出 sending repeat command event，聲軌峰值 0.0001）。
      // 所以不要在這裡假裝有退路——明講失敗，讓畫面去告訴訪客。
      settle(u, true);
    });
  }

  async function fetchToken(): Promise<string> {
    const response = await fetch(TOKEN_ENDPOINT, { method: "POST" });
    const body = (await response.json().catch(() => ({}))) as TokenResponse;

    if (!response.ok || !body.sessionToken) {
      // reason 是給人看的（at_capacity / budget_exhausted / disabled），
      // 呼叫端收到 onFatal 之後會降級成 monogram（「李」字＋老師的克隆聲），文字照常。
      throw new Error(
        `取得 avatar token 失敗（${response.status}${body.reason ? ` ${body.reason}` : ""}）`
      );
    }

    // 把伺服器說的上限往上報。⚠️ 不要讓呼叫端自己猜一個數字——
    // 猜大了她會在對話中途無預警消失，猜小了則是白白浪費已經付錢的時間。
    if (typeof body.maxSessionSeconds === "number" && body.maxSessionSeconds > 0) {
      hooks.onSessionLimit?.(body.maxSessionSeconds);
    }
    // 收線時要回報這個 id，帳本才記得到真實時長
    if (body.sessionId) hooks.onSessionOpened?.(body.sessionId);
    return body.sessionToken;
  }

  return {
    provider: "heygen",
    needsVideo: true,
    metered: true,
    get audioAvailable() {
      // 聲音跟影像走同一條 WebRTC 軌，attach() 之後就有；
      // 跟 monogram 不同，不需要這個瀏覽器自己有 Web Audio 能放裸 PCM。
      return prepared;
    },

    async prepare(video) {
      // 兩道 guard：prepared 擋重複開，preparing 擋還在飛的那一次。
      // reactStrictMode 會讓 effect 跑兩次，少一道就是開兩個計費 session。
      // 報過 fatal 的 driver 也不再開：呼叫端該換掉它，不是再試一次。
      if (prepared || preparing || dead || fatalReported) return;

      if (!video) {
        // 沒有 <video> 就不要開 session——開了也沒地方畫，純燒錢。
        reportFatal(new Error("heygen driver 需要 <video> 元素，但拿到的是 null"));
        return;
      }

      preparing = true;
      const beganAt = Date.now();
      trace("開始接通串流虛擬人");
      try {
        const [{ LiveAvatarSession, SessionEvent, AgentEventsEnum }, token] =
          await Promise.all([import("@heygen/liveavatar-web-sdk"), fetchToken()]);

        if (dead) return;
        trace("拿到 avatar token", `${Date.now() - beganAt}ms`);

        // voiceChat: false ＝ 不要麥克風。
        // 我們的互動在文字層（訪客打字 → RAG），開麥克風只會多要一次權限、
        // 多一個瀏覽器權限彈窗，而且完全用不到。
        const next = new LiveAvatarSession(token, { voiceChat: false });

        // 說話狀態直接用官方事件，不要自己用文字長度估時間——
        // 估的那套在 mock 裡是刻意的假時序，在這裡會跟真實嘴型對不上。
        next.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
          if (dead || fatalReported) return;
          setSpeaking(true);
        });
        next.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
          if (dead || fatalReported) return;
          const u = current;
          if (u && u.streamed) {
            // 串流收完、也沒有後段失敗：真的講完了，以事件為準，取消那條以時間估算的保險。
            if (!u.failed) settle(u, false);
            // 🔴 後段失敗、等著回報：**什麼都不做**，說話狀態撐到 endTimer 回報的那一刻
            // （settle(u, true) 同時收狀態＋報失敗）。跟 /live4 的 speakWithPlayer 同一個道理：
            // 這裡先報「講完了」的話，訪客在回報之前按下一題，LiveStage 看到 speaking 是 false
            // 就不會 stop()，這一則的回報照樣觸發，提示掛到新的一輪、新的答案底下。
            // 撐著的話，那一下會 stop() → halt()，回報跟著取消（被打斷不是失敗）。
            return;
          }
          // 還在送塊（這個事件可能只是其中一段講完），或手上沒有東西：只收說話狀態（舊行為）。
          setSpeaking(false);
        });

        // 斷線一律當成不可恢復：呼叫端會降級成 monogram（這個 mount 之後都是「李」字＋老師的聲音）。
        // 這裡不重連——重連等於重新計費，而且使用者已經看到畫面停住了。
        // ⚠️ start() 失敗時 SDK 會先發這個事件再丟例外，下面的 catch 也會回報一次，靠 reportFatal 去重；
        // 我們自己 destroy 時（CLIENT_INITIATED）已經 dead，不報。
        next.on(SessionEvent.SESSION_DISCONNECTED, (reason: SessionDisconnectReason) => {
          reportFatal(new Error(`LiveAvatar session 斷線：${reason}`));
        });

        const streamReady = new Promise<void>((resolve) => {
          next.once(SessionEvent.SESSION_STREAM_READY, () => resolve());
        });

        await next.start();
        trace("session.start() 完成", `${Date.now() - beganAt}ms`);
        if (dead || fatalReported) {
          // prepare 進行中被 destroy 了（切分頁、離開頁面），或連線途中就斷了。
          // 一定要把已經開起來的 session 收掉，否則它會一路計費到伺服器端上限。
          await next.stop().catch(() => {});
          return;
        }

        await streamReady;
        if (dead || fatalReported) {
          await next.stop().catch(() => {});
          return;
        }

        // attach() 會把影像與聲音兩條軌都掛到同一個元素上。
        // <video> 掛載時是 muted，解除靜音由使用者手勢那一側處理。
        next.attach(video);

        session = next;
        prepared = true;
        trace("串流就緒，她的臉是活的了", `${Date.now() - beganAt}ms`);

        // 連線期間送進來的答案在這裡補說。⚠️ 這一段不可以拿掉——
        // 沒有它，每次開頁之後的第一題都是無聲的。
        const queued = pendingSpeech;
        pendingSpeech = null;
        if (queued) {
          trace("補說連線期間排隊的答案", `${queued.length} 字`);
          speakNow(next, queued);
        }
      } catch (error) {
        // destroy（切分頁、離開頁面）之後才失敗的不算：呼叫端已經不要這個 driver 了，
        // 報上去只會讓畫面莫名其妙地降級。
        if (dead) return;
        trace("接通失敗", describe(error), "error");
        // 連不上就沒有人能說排隊的那句話了：reportFatal 會先把它報成「聲音沒出來」再丟掉
        // （留著只會在下一次 prepare 成功時突然講一段舊答案）。
        reportFatal(error instanceof Error ? error : new Error(String(error)));
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

      // 🔴 收下卻送不出的答案一律 onSpeechFailed（2026-09-29）。
      // 舊版「沒人在連」那條只寫一行 trace：畫面是答案文字＋一張不動的臉、沒有聲音也沒有任何提示，
      // 而那條路真的走得到（舊版 onFatal 之後的下一次按，AvatarStage 重建的 heygen 卡在 <video> 護欄）。
      if (fatalReported) {
        trace("答案無處可去：串流已經斷了", `${text.length} 字`, "error");
        hooks.onSpeechFailed?.();
        return;
      }

      // ⚠️ 還沒接通就把答案丟掉，等於第一題永遠不會有聲音。見 pendingSpeech 的說明。
      // 只在「正在連線」時排隊：prepare() 根本沒被呼叫過的話沒有東西可以等，
      // 排了也只會在很久以後憑空冒出一句話。
      if (!prepared || !session) {
        // ⚠️ 這兩條路的差別對診斷是關鍵，所以分開記：
        // preparing ＝ 還在連，等一下會補說；不 preparing ＝ 根本沒人在連，
        // 這一句話不會有聲音——明講，不要讓她只是靜靜地不出聲。
        if (preparing) {
          trace("答案比連線先到，先排隊", `${text.length} 字`, "warn");
          pendingSpeech = text;
        } else {
          trace("答案無處可去：串流沒有在連", `${text.length} 字`, "error");
          hooks.onSpeechFailed?.();
        }
        return;
      }

      trace("送去讓她開口", `${text.length} 字`);
      speakNow(session, text);
    },

    stop() {
      // ⚠️ 排隊中的那則也要丟掉，而且要在 `!session` 的提前 return 之前做。
      // 使用者按下按鈕就是要打斷；讓一則幾秒前的答案在連線完成的瞬間才冒出來，
      // 比她不出聲更難理解。
      pendingSpeech = null;
      if (dead) return;
      // 🔴 還在要語音／還在送塊的那一則也一起停，同樣要在提前 return 之前。
      // 只 interrupt 的話，之後才到的塊會被照樣送進播放緩衝，她停一下又接著講（A1、A2）。
      halt();
      if (!session || fatalReported) return;
      session.interrupt();
      setSpeaking(false);
    },

    async destroy() {
      if (dead) return;
      pendingSpeech = null;
      halt();
      setSpeaking(false);
      dead = true;
      prepared = false;
      const closing = session;
      session = null;
      if (!closing) return;
      // 收不掉也不能丟例外出去；伺服器端的 max_session_duration 是最後防線。
      await closing.stop().catch((error) => {
        console.error("[avatar] LiveAvatar session 關閉失敗：", error);
      });
    },
  };
}
