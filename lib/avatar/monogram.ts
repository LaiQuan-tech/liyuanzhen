import { trace } from "@/lib/trace";
import { LipSyncPlayer } from "./lipsync-player";
import { sequenceSpeechStreams, splitForSpeech } from "./speech-segments";
import { fetchTtsStream } from "./tts-request";
import type { AvatarDriver, AvatarDriverHooks } from "./types";

/**
 * 圓形「李」字標記 ＋ 老師的克隆聲（`/api/tts` → `LipSyncPlayer`）。
 *
 * 走這一支的有兩條路：
 * - `/chat` 的「開啟朗讀」。正式站沒設 NEXT_PUBLIC_AVATAR_PROVIDER，resolveProvider() 回 monogram，
 *   所以**不需要改任何環境變數**，文字對談的朗讀就是這個聲音。
 * - 語音頁（/live 系列）的 heygen driver 載入失敗時，createAvatarDriver 降級到這裡。
 *
 * 🔴 2026-09-29 以前這裡是裝置內建語音：挑清單裡第一個 zh-TW 語音，Mac 上挑到的是男聲「Eddy」，
 * 而且每台裝置都不一樣。使用者問「聲音已經改成只有一種版本了嗎？之前有好多版本」，
 * 選了「改成老師的聲音」——所以現在全站只剩老師這一種聲音。
 * ⚠️ **不可以**把裝置語音加回來當退路，連「合成失敗時暫代一下」都不行：那正是使用者要拿掉的東西。
 * 失敗一律走 hooks.onSpeechFailed，由畫面說明「這次的聲音沒出來、答案在上面」。
 *
 * 代價（已向使用者說明、使用者接受）：
 * - 每次朗讀都會用到 ElevenLabs 額度。/chat 的朗讀預設是關的，訪客自己按了才會花。
 * - 要等整段答案出來、再 1～2 秒才開口（首字延遲），不再邊收邊逐句念。
 *
 * 它仍然是所有其他 driver 的退路，所以：不開計費 session（metered false，不掛閒置退場那一套）、
 * 不需要 <video>、任何方法都不丟例外。
 */

/**
 * 多久沒有收到任何**新的**音訊資料就算卡住（看門狗）。
 *
 * 跟 heygen 的 SPEAK_STARTUP_TIMEOUT_MS 同一個數字、同一個理由：TTS 卡住時，
 * 畫面不可以一直停在「回答中」、「停止」一直亮著。正常的首字延遲約 3.6 秒（含重試也遠低於此），
 * 串流中每一塊之間是毫秒級，段與段之間是下一段的首字延遲。
 *
 * 🔴 不能只守「第一塊」。長答案切成好幾段，第二段的請求一樣會卡（平台層逾時要 60 秒、
 * 重試三次就是三分鐘；網路層卡死則沒有上限），那段時間第一段早就唸完了，
 * 畫面卻一直寫著「回答中」。所以每收到一塊就重新計時：
 * - 還沒出聲就卡住 → 直接失敗、回報
 * - 已經在唸了才卡住 → 放掉卡住的那一段（同一時間只會有一個請求在飛），
 *   已經排進播放圖的讓它唸完，唸完再回報——不在她講話時跳提示
 */
const STALL_TIMEOUT_MS = 20_000;

/**
 * 播放圖排完之後再多等多久才回報「講完了」。
 * LipSyncPlayer 的輸出經過 <audio> 元素（iOS 修法），會多 20–60ms 的輸出延遲；
 * 太早回報的話頭像會在最後一個字還沒出聲時就停下來。
 */
const END_GRACE_MS = 250;

/** `canPlayClonedVoice` 需要看的那幾樣東西。刻意是鬆的型別，node 測試可以直接塞物件。 */
export interface ClonedVoiceEnv {
  AudioContext?: unknown;
  webkitAudioContext?: unknown;
  fetch?: unknown;
  ReadableStream?: unknown;
}

/**
 * 這個瀏覽器放不放得出克隆聲。
 *
 * 取代原本的「這台裝置有沒有中文語音」：聲音現在是伺服器合成、瀏覽器只負責播放，
 * 需要的是 Web Audio（播裸 PCM）＋ fetch 的串流 body。缺一樣就是 false，
 * /chat 會顯示「此瀏覽器無法播放語音」而不是一顆按了沒反應的按鈕。
 * Safari 舊版只有 webkit 前綴，也算。
 */
export function canPlayClonedVoice(env: ClonedVoiceEnv | undefined): boolean {
  if (!env) return false;
  const hasWebAudio =
    typeof env.AudioContext === "function" || typeof env.webkitAudioContext === "function";
  return hasWebAudio && typeof env.fetch === "function" && typeof env.ReadableStream === "function";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 一次朗讀（一則答案）。每則答案一個，打斷就整個丟掉。 */
interface Utterance {
  /** 這一則所有請求共用。段落是依序要的，同一時間只會有一個請求在飛 */
  abort: AbortController;
  /** 看門狗，見 STALL_TIMEOUT_MS。串流收完就撤掉 */
  watchdog: ReturnType<typeof setTimeout> | null;
  /** 串流收完之後，等播放圖上剩下的聲音唸完 */
  endTimer: ReturnType<typeof setTimeout> | null;
  /** 至少一塊音訊排進播放圖了 */
  heard: boolean;
  /** 中途有一段沒拿到／斷掉。已經排進去的照樣唸完，唸完再回報 */
  failed: boolean;
}

export function createMonogramDriver(hooks: AvatarDriverHooks): AvatarDriver {
  let dead = false;
  /**
   * ⚠️ 只在 unlockAudio()（使用者手勢）裡建立。建構子本身不開 AudioContext，
   * 但 prime() 會開——那一刻必須在手勢裡，理由見 unlockAudio。
   */
  let player: LipSyncPlayer | null = null;
  /** 正在進行的那一則。null ＝ 沒在唸也沒在要 */
  let current: Utterance | null = null;
  /** 最後一次回報給呼叫端的說話狀態。只在變化時回報，避免 stop() 連發 */
  let speaking = false;

  function supported(): boolean {
    return canPlayClonedVoice(typeof window === "undefined" ? undefined : window);
  }

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

  /** 看門狗重新計時。送出時與每收到一塊音訊時呼叫，見 STALL_TIMEOUT_MS。 */
  function armWatchdog(u: Utterance) {
    if (current !== u) return;
    if (u.watchdog !== null) clearTimeout(u.watchdog);
    u.watchdog = setTimeout(() => {
      u.watchdog = null;
      if (current !== u) return;
      if (!u.heard) {
        fail(u, `${STALL_TIMEOUT_MS / 1000} 秒內沒有收到任何音訊`);
        return;
      }
      // 已經在唸了：不切掉正在唸的。取消卡住的那個請求（同一時間只有一個在飛），
      // 串流因此照常收尾（sequenceSpeechStreams 不丟錯），speak() 會等播放圖唸完再回報失敗。
      u.failed = true;
      trace(
        "克隆語音中途卡住",
        `${STALL_TIMEOUT_MS / 1000} 秒沒有收到新的音訊，放棄後面的段落`,
        "error"
      );
      u.abort.abort(new DOMException("克隆語音卡住，放棄後面的段落", "AbortError"));
    }, STALL_TIMEOUT_MS);
  }

  /**
   * 立刻收掉目前這一則，不回報失敗（被打斷不是失敗）。
   *
   * 🔴 三件事缺一不可：
   * - abort 在飛的 fetch：只停播放的話，還在飛的那一次合成會在幾秒後到達並開始唸——
   *   訪客已經在看下一題了。（ChibiStage 的 stop 註解記著同一件事。）
   * - player.stop()：已經排進播放圖的 source 要停，不然會唸完整段。
   * - current 先清成 null 再 abort：abort 會讓 speak() 的 await 醒來，它靠 `current !== u`
   *   認出自己已經過期，才不會把「被取消」誤報成「聲音沒出來」。
   */
  function halt() {
    const u = current;
    current = null;
    if (u) {
      clearTimers(u);
      u.abort.abort();
    }
    player?.stop();
    setSpeaking(false);
  }

  /** 這一則結束了（講完或失敗）。已經被打斷的舊一則呼叫進來會被忽略。 */
  function settle(u: Utterance, failed: boolean) {
    if (current !== u) return;
    current = null;
    clearTimers(u);
    setSpeaking(false);
    if (failed) hooks.onSpeechFailed?.();
  }

  /**
   * 失敗收尾：取消請求、停掉已排的聲音、回報。🔴 絕不退回裝置語音，見檔頭。
   * abort 喚醒的 await 都是 microtask，會在 settle() 把 current 清掉之後才跑，
   * 所以 speak() 的 catch 看到的一定是 `current !== u`，不會重複回報。
   */
  function fail(u: Utterance, why: string) {
    if (current !== u) return;
    trace("克隆語音失敗", why, "error");
    u.abort.abort();
    player?.stop();
    settle(u, true);
  }

  async function speak(u: Utterance, p: LipSyncPlayer, segments: string[]): Promise<void> {
    const { signal } = u.abort;
    try {
      trace(
        "向 /api/tts 要克隆語音",
        `${segments.reduce((sum, s) => sum + s.length, 0)} 字，分 ${segments.length} 段`
      );
      // 重試策略跟 heygen 同一份（lib/avatar/tts-request.ts）
      const first = await fetchTtsStream(segments[0], { signal });
      if (current !== u) {
        first.cancel().catch(() => {});
        return;
      }

      // 🔴 await 回來之後、play() 之前再問一次。play() 看到 suspended 會 await resume()，
      // 而沒有手勢的 resume() 可能永遠不 resolve——那會讓這一則永遠卡在「回答中」。
      // （iOS 切到背景再回來就可能是這樣。）寧可明講這次沒聲音；下一次送出問題的手勢會重新解鎖。
      if (p.contextState !== "running") {
        first.cancel().catch(() => {});
        fail(u, `AudioContext 是 ${p.contextState ?? "未建立"}，放不出聲音`);
        return;
      }

      const stream = sequenceSpeechStreams(
        segments,
        // ⚠️ 第二段以後也要帶 signal：念到一半被打斷時，還在飛的那一段合成要一起取消，
        // 不然照樣吃額度、吃一格限流（monogram.test.ts 有一條鎖著）
        (text, index) => (index === 0 ? Promise.resolve(first) : fetchTtsStream(text, { signal })),
        (index, error) => {
          if (current !== u) return;
          u.failed = true;
          trace(
            "克隆語音中途斷掉",
            `第 ${index + 1}/${segments.length} 段：${describe(error)}`,
            "error"
          );
        },
        () => armWatchdog(u)
      );

      await p.play(stream, () => {
        u.heard = true;
      });
      if (current !== u) return;

      // 串流收完了，後面只剩等播放圖唸完——這段不需要（也不可以）再守：
      // 一段 100 秒的話串流 45 秒就收完，看門狗留著會在她還在唸的時候誤判成卡住。
      if (u.watchdog !== null) {
        clearTimeout(u.watchdog);
        u.watchdog = null;
      }

      // 一個取樣都沒收到（例如合成回了空的 200）：跟失敗一樣要講，不然就是無聲＋零解釋
      if (!u.heard) u.failed = true;

      // 串流收完不等於講完：ElevenLabs 約 2.25 倍實時，後面還有大半截排在播放圖上。
      // 用播放時鐘算剩多少，而不是估字數——估的那套是 mock 刻意的假時序。
      u.endTimer = setTimeout(
        () => settle(u, u.failed),
        p.pendingSeconds * 1000 + END_GRACE_MS
      );
    } catch (error) {
      // 被打斷（關閉朗讀、送出新問題、卸載）時 current 已經不是 u 了，那不是失敗
      if (current !== u) return;
      fail(u, describe(error));
    }
  }

  return {
    provider: "monogram",
    needsVideo: false,
    /**
     * ⚠️ 仍然是 false，雖然每次朗讀都要錢。
     * metered 的意思是「活著就在花錢／佔遠端 session」，決定要不要掛閒置退場、切背景就收那一套；
     * 這支是**唸一次付一次**、沒有 session 要收，掛那一套只會讓它閒置 75 秒後莫名啞掉。
     */
    metered: false,
    get audioAvailable() {
      return !dead && supported();
    },

    async prepare() {
      // 沒有東西要準備：沒有 session 要開，而 AudioContext 必須等手勢（unlockAudio）。
      // ⚠️ 不要在這裡開 AudioContext——AvatarStage 在掛載時就會呼叫 prepare(null)，
      // 那時候沒有手勢，開出來的 context 是 suspended（Safari 尤其回不來）。
    },

    unlockAudio() {
      if (dead || !supported()) return;
      try {
        // 🔴 prime() 同步建立／resume AudioContext，並在手勢裡把 <audio> 元素 play 起來
        // ——後者是 iOS 靜音鍵下還有聲音的關鍵，理由見 lipsync-player.ts 的 mediaDest 註解。
        player ??= new LipSyncPlayer();
        player.prime();
      } catch (error) {
        trace("AudioContext 開不起來", describe(error), "error");
      }
    },

    push() {
      // 等整段答案才開口，串流中的 delta 一律忽略。兩個理由，缺一都不足以留白：
      // 1. lib/answer-guard 命中封鎖清單時會停止輸出並追加婉拒句，那個判定要等到後面才發生——
      //    邊收邊唸的話，被判定為不該說的那段已經用她的聲音講出去了（見 types.ts 的 speakableAnswer）。
      // 2. ElevenLabs 是整段合成，逐句送等於每句開一次請求，既貴又會把語氣切成一格一格的。
    },

    finish(fullText) {
      if (dead) return;
      const text = fullText.trim();
      // 空字串送去 /api/tts 只會換到一個 400。沒有東西要唸，也不該回報「聲音沒出來」——
      // 那會在畫面上多一句沒有指涉對象的提示。
      if (!text) return;

      // 上一則還在唸或還在飛：先收乾淨。play() 自己會 stop 上一段，但它管不到 fetch。
      halt();

      const p = player;
      if (!supported() || !p || p.contextState !== "running") {
        // 🔴 沒解鎖過就不要硬開：這時候建 AudioContext 不在手勢裡，會是 suspended，
        // play() 會卡在 await resume()。也不要先花一次合成額度再發現放不出來。
        // 正常流程走不到這裡——/chat 按「開啟朗讀」與每次送出、/live 按說話按鈕都會先 unlockAudio。
        trace(
          "這一則放不出克隆語音",
          !supported()
            ? "瀏覽器沒有 Web Audio"
            : !p
              ? "沒有經過手勢解鎖（unlockAudio 沒被呼叫過）"
              : `AudioContext 是 ${p.contextState ?? "未建立"}`,
          "error"
        );
        hooks.onSpeechFailed?.();
        return;
      }

      const u: Utterance = {
        abort: new AbortController(),
        watchdog: null,
        endTimer: null,
        heard: false,
        failed: false,
      };
      current = u;

      // ⚠️ 請求在飛的時候就要回報 true，不要等第一個音出來。
      // 答案文字出現到她開口之間有 1～2 秒（首字延遲），這段回報 false 的話畫面是
      // 「答案出來了、頭像一臉閒著」，而且「停止」按鈕不會出現、按不掉這一次合成。
      setSpeaking(true);
      armWatchdog(u);

      void speak(u, p, splitForSpeech(text));
    },

    stop() {
      if (dead) return;
      halt();
    },

    async destroy() {
      if (dead) return;
      halt();
      dead = true;
      // ⚠️ 一定要 dispose。Chrome 對同一個分頁的 AudioContext 數量有上限（約 6 個），
      // 反覆進出 /chat 就會開不出新的，症狀是按了朗讀但沒有聲音。
      player?.dispose();
      player = null;
    },
  };
}
