"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import AvatarStage, { type AvatarStageHandle } from "@/components/avatar/AvatarStage";
import { speakableAnswer } from "@/lib/avatar";
import {
  createRecorder,
  MicrophoneError,
  MAX_RECORDING_SECONDS,
  SILENCE_RMS,
  type Recorder,
  type RecordingResult,
} from "@/lib/live/recorder";
import { METER_BARS, meterBarHeight, smoothLevel } from "@/lib/live/level";
import TracePanel from "@/components/live/TracePanel";
import { trace, traceReset } from "@/lib/trace";
import {
  deriveLiveState,
  avatarStateFor,
  canStartRecording,
  isBusy,
  talkButtonAction,
  type TurnPhase,
} from "@/lib/live/state";
import { resolveProvider } from "@/lib/avatar";
import {
  AVATAR_NAME,
  ANSWER_DISCLAIMER,
  SITE_NOTICE,
  GUARDED_REPLY,
  liveCopy,
} from "@/content/site";

interface Turn {
  role: "user" | "model";
  text: string;
}

/** 逾時。⚠️ 只包得住 fetch，包不住讀 body——串流讀取要另外想。 */
const STT_TIMEOUT_MS = 15_000;
/**
 * ⚠️ 要跟伺服器的 `maxDuration`（30 秒）對齊，不要比它短。
 *
 * 原本是 20 秒，而正式站冷啟動的 /api/chat 實測超過 20 秒——於是前端在
 * 伺服器還在正常工作的時候就把它丟掉了，畫面顯示「抱歉，我需要休息一下」。
 * 比伺服器早放棄，只會把「慢」變成「失敗」。預熱（見上面）是主要修法，
 * 這個數字是安全網。
 */
const CHAT_TIMEOUT_MS = 28_000;

/**
 * 這一頁要的是串流虛擬人——沒有那張臉，/live 就沒有存在的意義，
 * 所以預設直接指定 heygen，不看 NEXT_PUBLIC_AVATAR_PROVIDER。
 *
 * 唯一的例外是 `mock`：做版面、測互動、驗浮水印與閒置退場時用它，
 * 一毛錢都不用花。設 NEXT_PUBLIC_AVATAR_PROVIDER=mock 就會切過去。
 */
const LIVE_PROVIDER = resolveProvider() === "mock" ? "mock" : "heygen";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

/**
 * 全螢幕的數位李元貞。點一下說話，她用自己的聲音與臉回答。
 *
 * 鏈路：麥克風 → WAV → /api/stt → /api/chat（RAG ＋ answer-guard）
 *      → /api/tts（她的克隆聲）→ LiveAvatar 對嘴
 *
 * ⚠️ 三條不可以拿掉的護欄，全螢幕比文字版更需要它們：
 *
 * 1. **非 200 的回應絕不餵給 avatar。** /api/chat 回 403 / 429 / 400 時
 *    body 是錯誤訊息不是答案。少了這道分界，她會用克隆的聲音唸出
 *    「請求格式錯誤。」（Sunny 展場版踩過並留下註解警告。）
 * 2. **一定要送 speakableAnswer 而不是 answer。** 理由見 lib/avatar/types.ts。
 * 3. **AVATAR_NAME、ANSWER_DISCLAIMER、SITE_NOTICE、浮水印都要在畫面上。**
 *    Nav/Footer 是每頁自己掛的，這一頁沒有掛，所以必須自己放。
 *    一張佔滿螢幕、會說話的臉，正是最可能被錄下來轉傳的東西。
 */
export default function LiveStage() {
  const [recording, setRecording] = useState(false);
  /** 麥克風即時音量（0~1）。只用來畫回饋，不參與任何判斷。 */
  const [level, setLevel] = useState(0);
  const [phase, setPhase] = useState<TurnPhase>("idle");
  const [speaking, setSpeaking] = useState(false);
  const [notice, setNotice] = useState("");
  /** 已經錄了幾秒。只用來顯示，不參與任何判斷。 */
  const [elapsed, setElapsed] = useState(0);
  const [heard, setHeard] = useState("");
  const [answer, setAnswer] = useState("");

  const stageRef = useRef<AvatarStageHandle>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const sessionIdRef = useRef("");
  const messagesRef = useRef<Turn[]>([]);
  /** 已經開過串流沒——沒開過就不該顯示「連線已結束」 */
  const startedRef = useRef(false);
  /**
   * 錄音撞到 30 秒上限時要呼叫的東西。
   *
   * ⚠️ 用 ref 轉一手，不要讓 useEffect 直接捕捉 release——
   * release 宣告在 effect 後面，靠「effect 只在 render 之後才跑」才不會踩到 TDZ。
   * 那能動，但它是一個沒有寫出來的假設，改動順序就會壞。
   */
  const autoStopRef = useRef<() => void>(() => {});
  /**
   * 這一次錄音是什麼時候開始的（`Date.now()`）。沒在錄音就是 null。
   *
   * ⚠️ 用 ref 不用 state：它只在事件處理當下被讀一次，拿來判斷
   * 「這一下點擊是不是連點的第二下」。放進 state 會讓每次 render 都多一個
   * 沒人看的值，而且讀到的可能是上一輪 render 的舊值。
   */
  const recordingStartedAtRef = useRef<number | null>(null);
  /**
   * `recording` 的鏡像。
   *
   * ⚠️ `release()` 是 `useCallback(..., [runTurn])`，把 `recording` 加進 deps
   * 會讓它每次錄音狀態變化就換一個新的函式實體，而 `autoStopRef.current`
   * 是在 render 期間賦值的——兩者一起會出現「計時器抓到舊的 release」。
   * 用鏡像 ref 讀就沒有這個問題。
   */
  const recordingRef = useRef(false);
  /**
   * 這一輪的序號。
   *
   * ⚠️ `release()` 與 `runTurn()` 都是非同步的，而使用者隨時可以再按一次。
   * 沒有這個序號，晚一步 resolve 的**上一輪**會把它的訊息寫回畫面——
   * 實測畫面：新的錄音正在進行（按鈕是「放開送出」、音量計在動），
   * 上面卻掛著上一輪的「按住不放，講完再放開。」，使用者完全無從理解。
   */
  const turnRef = useRef(0);

  const state = deriveLiveState({ recording, phase, speaking, errored: Boolean(notice) });
  /** 最後 10 秒。到點會自動送出，所以要先講，而且要倒數。 */
  const nearCap = elapsed >= MAX_RECORDING_SECONDS - 10;

  useEffect(() => {
    sessionIdRef.current =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now());

    // 預熱這一頁真正會用到的兩支 lambda。
    //
    // 🔴 原本這裡只 ping `/api/health`，而那支在正式站是被 Vercel 邊緣快取的
    // （實測 `x-vercel-cache: HIT`、`age: 141`），請求根本到不了任何 lambda——
    // 也就是這幾個月的「預熱」一次都沒有真的發生過。
    // 實測正式站冷啟動的 /api/chat 超過 20 秒，被前端逾時丟掉，
    // 訪客看到的是「抱歉，我需要休息一下」：一個完全正確的請求被當成失敗。
    //
    // ⚠️ 要打的是**這一頁自己會用的那幾支**。Vercel 上每一支 route 是獨立的
    // function，熱了一支不代表熱了另一支。
    void fetch("/api/stt", { method: "GET" }).catch(() => {});
    void fetch("/api/chat", { method: "GET" }).catch(() => {});

    const recorder = createRecorder({
      onAutoStop: () => {
        // 撞到錄音上限（45 秒）。當成按了第二下處理，不要無聲地丟掉他講的話。
        autoStopRef.current();
      },
      // 即時音量。⚠️ 一定要走 smoothLevel（峰值保持 ＋ 衰減），不要直接餵瞬時值：
      // 人講話字與字之間本來就有停頓，瞬時值會掉到底噪，音量計就會塌成一排點。
      onLevel: (rms) => setLevel((prev) => smoothLevel(prev, rms)),
    });
    recorderRef.current = recorder;
    return () => {
      void recorder.dispose();
      recorderRef.current = null;
    };
  }, []);

  // 錄音秒數。⚠️ 200ms 更新一次就夠了——它只是給人看的，
  // 更密只會多做無謂的 render，而音量計本來就一直在動。
  useEffect(() => {
    if (!recording) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    /**
     * ⚠️ 順手在這裡節流回報活動。
     *
     * `AvatarStage` 的閒置計時器是 75 秒，而錄音上限從 30 秒放寬到 45 秒之後，
     * 「按下 → 錄滿 → STT 回來」最長約 47 秒，離 75 秒只剩 28 秒的餘裕。
     * 錄音期間本來一個 reportActivity 都沒有（下一次要等逐字稿回來），
     * 所以再放寬上限就會出現「訪客正在講話，計費中的 session 被收掉」。
     * 20 秒一次就夠，不要每 200ms 都打——那只是讓計時器空轉。
     */
    let lastPing = startedAt;
    const id = setInterval(() => {
      const now = Date.now();
      setElapsed((now - startedAt) / 1000);
      if (now - lastPing >= 20_000) {
        lastPing = now;
        stageRef.current?.reportActivity();
      }
    }, 200);
    return () => clearInterval(id);
  }, [recording]);

  /** 跑完一輪：逐字稿 → RAG ＋ 生成 → 她開口 */
  const runTurn = useCallback(async (audio: RecordingResult, turn: number) => {
    /** 使用者已經開始下一輪了嗎。是的話這一輪的所有結果都要丟掉。 */
    const stale = () => turnRef.current !== turn;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setNotice(liveCopy.offline);
      return;
    }

    setPhase("transcribing");
    try {
      trace(
        "送出音訊到 /api/stt",
        `${audio.seconds.toFixed(1)}s、${audio.blob.size} bytes、${audio.mimeType}`
      );
      const sttResponse = await withTimeout(
        fetch("/api/stt", {
          method: "POST",
          // ⚠️ 用錄音器回報的 mimeType，不要寫死。Chrome 給 webm、Safari 給 mp4、
          // Firefox 給 ogg，三種 Gemini 都收（實測見 lib/live/recorder.ts 檔頭）。
          headers: { "Content-Type": audio.mimeType },
          body: audio.blob,
        }),
        STT_TIMEOUT_MS
      );

      if (stale()) return;
      trace("/api/stt 回應", `HTTP ${sttResponse.status}`, sttResponse.ok ? "info" : "error");
      if (!sttResponse.ok) {
        setNotice(liveCopy.notHeard);
        return;
      }
      const { transcript } = (await sttResponse.json()) as { transcript?: string };
      if (stale()) return;
      // ⚠️ 空字串**不可以**安靜地忽略。
      // 這裡收到空字串代表使用者真的按住、真的講了（太短的誤觸在 recorder.stop()
      // 就回 null 了，根本到不了這裡），只是辨識不出內容。
      // 原本寫「安靜地什麼都不做」，實際症狀就是使用者回報的「說話沒有反應」——
      // 按了、講了、放開，畫面一個字都沒變，他無法分辨是自己的問題還是網站壞了。
      if (!transcript) {
        trace("逐字稿是空的", "有聲音但辨識不出內容", "warn");
        setNotice(liveCopy.heardNothing);
        return;
      }
      trace("逐字稿", transcript);

      // 逐字稿一回來就打上去（約 1 秒）。這是整段等待裡最重要的一個回饋：
      // 它證明她真的聽到了，接下來的幾秒沉默才不會像當機。
      setHeard(transcript);
      setAnswer("");
      stageRef.current?.reportActivity();

      const history: Turn[] = [...messagesRef.current, { role: "user", text: transcript }];
      setPhase("thinking");

      const chatResponse = await withTimeout(
        fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // 這裡送進去的 transcript 已經是 /api/stt 轉好的純文字，
          // 跟打字提問無從分辨。channel 是後台唯一能認出「這是語音問的」的依據。
          body: JSON.stringify({
            sessionId: sessionIdRef.current,
            messages: history,
            channel: "live",
          }),
        }),
        CHAT_TIMEOUT_MS
      );

      if (stale()) return;
      trace("/api/chat 回應", `HTTP ${chatResponse.status}`, chatResponse.ok ? "info" : "error");
      // ⚠️ 護欄 1：非 200 的 body 是錯誤訊息不是答案。
      // 這裡 return 掉，絕不讓它流到下面的 finish()。
      if (!chatResponse.ok || !chatResponse.body) {
        console.error("[live] /api/chat 失敗：", chatResponse.status);
        setNotice(liveCopy.failed);
        return;
      }

      const reader = chatResponse.body.getReader();
      const decoder = new TextDecoder();
      let full = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (stale()) {
          void reader.cancel().catch(() => {});
          return;
        }
        if (done) break;
        full += decoder.decode(value, { stream: true });
        setAnswer(full);
      }
      full += decoder.decode();

      messagesRef.current = [...history, { role: "model", text: full }];
      setAnswer(full);
      stageRef.current?.reportActivity();

      trace("答案完成", `${full.length} 字`);

      // ⚠️ 護欄 2：送 speakableAnswer，不是 full。
      stageRef.current?.finish(speakableAnswer(full, GUARDED_REPLY));
    } catch (error) {
      trace("這一輪失敗", error instanceof Error ? error.message : String(error), "error");
      if (!stale()) setNotice(liveCopy.failed);
    } finally {
      if (!stale()) setPhase("idle");
    }
  }, []);

  /**
 * 麥克風權限還停在「尚未決定」嗎。
 *
 * ⚠️ 用 try/catch 包起來並預設 false：Permissions API 在 Safari 與 Firefox 上
 * 對 `microphone` 這個名稱的支援不一致，查不到就當作沒有這回事，
 * 走原本的誤觸文案——寧可少講一句，也不要對著授權過的人喊「請按允許」。
 */
async function microphonePending(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    return status.state === "prompt";
  } catch {
    return false;
  }
}

/** 放開按鈕（或撞到錄音上限）→ 收音、送出 */
  const release = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    // 🔴 沒在錄音就什麼都不要做。
    //
    // 按住式的時候這道守門不需要——pointerup 一定跟在 pointerdown 後面。
    // 切換式下就不是了：任何一次跑到這裡而麥克風其實沒開的情況，
    // `recorder.stop()` 會回 `{kind:"aborted"}`，於是畫面噴出一句
    // 「按住不放，講完再放開」——一句跟他剛做的動作完全無關的話。
    // 分派層（talkButtonAction）已經擋過一次，這是第二道。
    if (!recordingRef.current) return;

    const turn = turnRef.current;
    recordingRef.current = false;
    recordingStartedAtRef.current = null;
    setRecording(false);
    const outcome = await recorder.stop();
    // ⚠️ 使用者已經按下一輪了 → 這一輪的訊息一個字都不要寫回畫面
    if (turnRef.current !== turn) return;

    // ⚠️ 這一支要**第一個**判斷，而且必須跟 tooShort 分開。
    // 按住夠久卻一塊音訊都沒收到 ＝ 錄音管線死掉，不是誤觸。
    // 合在一起的那一版真的上線過：使用者按住講了一秒，畫面回他「按住不放」。
    if (outcome.kind === "no-audio") {
      setNotice(liveCopy.micDead);
      return;
    }

    // 誤觸，或放得比 getUserMedia 還快。給一句提示就好，不要當成錯誤。
    if (outcome.kind !== "ok") {
      // ⚠️ 但要先排除「權限詢問還開著」這一種。第一次來訪按住說話會跳出
      // 瀏覽器的麥克風權限詢問，而要按「允許」就必須先放開按鈕——
      // 於是每個新訪客的第一次嘗試都注定被判成 aborted。
      // 對他說「按住不放」是指著錯的方向，他會一直重複同一個注定失敗的動作。
      setNotice((await microphonePending()) ? liveCopy.micNeedsAllow : liveCopy.tooShort);
      return;
    }

    // 有錄到但整段都在底噪之下——麥克風沒開、被靜音、或講得太小聲。
    // ⚠️ 在這裡就擋下來，不要送去 /api/stt：伺服器只會回一個空字串，
    // 而「沒收到聲音」跟「聽不出內容」對使用者是完全不同的兩件事。
    //
    // 🔴 `peak` 是 null 時**一定要放行**。null 代表音量計沒跑起來（AudioContext
    // 被自動播放政策擋住），那是「不知道」不是「靜音」。當成 0 的話，
    // 訪客明明講了話卻會被回「沒有收到聲音」——而且他完全無從得知為什麼。
    if (outcome.peak !== null && outcome.peak < SILENCE_RMS) {
      trace("整段都在底噪之下", `峰值 ${outcome.peak.toFixed(5)} < ${SILENCE_RMS}`, "warn");
      setNotice(liveCopy.noSound);
      return;
    }

    await runTurn(outcome, turn);
  }, [runTurn]);

  autoStopRef.current = () => void release();

  /** 按下按鈕 → 開串流（第一次）＋ 開麥克風 */
  const press = useCallback(async () => {
    if (!canStartRecording(state)) return;

    // 開新的一輪。⚠️ 一定要在清畫面**之前**遞增，
    // 否則上一輪剛好在這個瞬間 resolve 的話還是會蓋回來。
    turnRef.current += 1;
    traceReset();
    trace("按下按鈕");
    setNotice("");
    // ⚠️ 上一輪的問題與答案要一起清掉。留著的話，新的提示會疊在舊問題下面
    // （實測畫面：「你問：00:00」上面掛著「按住不放，講完再放開」），
    // 使用者會以為那句提示是在回應舊的那一題。
    setHeard("");
    setAnswer("");
    stageRef.current?.reportActivity();
    // 她還在講就先閉嘴。這是刻意允許的打斷——
    // Sunny 展場版沒做，症狀是兩段語音重疊。
    if (speaking) stageRef.current?.stop();

    // ⚠️ 這一下按壓就是自動播放解鎖的手勢，也是串流開始計費的那一刻。
    // 跟錄音並行跑：session 建立約 0.9 秒，剛好被訪客講話的時間蓋過去，
    // 這段延遲是免費的。prepare() 本身冪等，第二次之後就是 no-op。
    startedRef.current = true;
    // ⚠️ 這一次要帶 unmute：自動連線那一次刻意保持靜音（沒有手勢就解不了靜音），
    // 所以真正讓她出聲的是這裡。
    void stageRef.current?.prepare({ unmute: true });

    // 🔴 立刻切成「錄音中」，**不要**等 start() resolve。
    //
    // start() 裡面有 getUserMedia（一般 100~300ms，第一次要等使用者按允許），
    // 前一版還在裡面等第一塊音訊最多 700ms。那段時間按鈕仍寫著「按住說話」、
    // 音量計不出現——使用者按下去看到畫面完全沒動，結論只會是「壞了」，
    // 然後放開再按一次，於是連正常的那一輪也被自己中斷。
    // 麥克風確實正在開，畫面就該這樣說；真的開不起來下面會改回來並說明原因。
    recordingRef.current = true;
    recordingStartedAtRef.current = Date.now();
    setRecording(true);
    try {
      await recorderRef.current?.start();
    } catch (error) {
      recordingRef.current = false;
      recordingStartedAtRef.current = null;
      setRecording(false);
      trace("麥克風開不起來", String(error), "error");
      if (error instanceof MicrophoneError) {
        setNotice(
          error.reason === "denied"
            ? liveCopy.micDenied
            : error.reason === "unsupported"
              ? liveCopy.micUnsupported
              : liveCopy.micUnavailable
        );
        return;
      }
      setNotice(liveCopy.micUnavailable);
    }
  }, [speaking, state]);

  /**
   * 點一下說話按鈕。
   *
   * 🔴 2026-09-03 從「按住說話」改成這個。按住式對手滑毫無容錯：手指移開
   * 按鈕範圍一點點就送出半句話，而且它還有一個**每個新訪客必踩**的洞——
   * 第一次按住會跳出麥克風權限詢問，要按「允許」就得先放開按鈕，
   * 於是第一次嘗試注定被判成 aborted（見 liveCopy.micNeedsAllow 的註解）。
   * 切換式兩個問題都沒有。
   *
   * ⚠️ 判斷本身在 `talkButtonAction()`（lib/live/state.ts），不要搬回這裡：
   * 這個檔案裡的任何東西都沒有測試（vitest 是 node 環境、沒有 jsdom，
   * 專案裡連一個 .test.tsx 都沒有），搬進來等於把判斷放到測不到的地方。
   */
  const toggle = useCallback(() => {
    const startedAt = recordingStartedAtRef.current;
    const action = talkButtonAction(state, startedAt === null ? null : Date.now() - startedAt);
    if (action === "start") void press();
    else if (action === "stop") void release();
    // "ignore"：連點的第二下，或伺服器往返中。刻意什麼都不做，
    // 也刻意**不**顯示提示——那一下對使用者來說不是一個「失敗」。
  }, [press, release, state]);

  /**
   * 影像還在、聲音沒出來。
   *
   * ⚠️ 這不是「這一輪失敗」——答案已經在畫面上了，所以文案與版位都要跟 failed 分開，
   * 提示要出現在答案**底下**而不是取代它（見下面 notice 的排版）。
   */
  const handleSpeechFailed = useCallback(() => {
    setNotice(liveCopy.voiceFailed);
  }, []);

  /** 串流被收掉了（閒置、切到背景、撞到伺服器上限）*/
  const handleTeardown = useCallback(() => {
    if (!startedRef.current) return;
    // 這不是錯誤，是預期中的行為。文案要講得像正常流程。
    setNotice(liveCopy.sessionEnded);
  }, []);

  const statusLine =
    state === "transcribing"
      ? liveCopy.transcribing
      : state === "thinking"
        ? liveCopy.thinking
        : state === "speaking"
          ? liveCopy.speaking
          : // 錄音中刻意留白：按鈕本身已經寫著「放開送出」，
            // 底下也有「錄音中，講完放開」，字幕再講一次只是重複。
            "";

  return (
    <div className="relative h-[100dvh] w-full overflow-hidden bg-ink text-white">
      {/* ⚠️ autoStart 只在這一頁開。/chat 也掛 AvatarStage，那邊自動連費用直接翻倍，
          而且 /chat 的主體本來就是文字，沒有臉也完全能用。

          🔴 fullBody 與 poster 是綁在一起的一組，不要只改其中一個。
          合成模式下 poster 會被縮到頭部那一格、跟串流疊在同一個位置，
          所以它必須是 avatar-poster-stage.jpg（原始真實照片、背景已對齊串流）。
          換別張對位會整個跑掉。理由與對位方法見
          components/avatar/full-body-stage.tsx 的檔頭。 */}
      <AvatarStage
        ref={stageRef}
        state={avatarStateFor(state)}
        size="full"
        provider={LIVE_PROVIDER}
        onSpeakingChange={setSpeaking}
        onTeardown={handleTeardown}
        onSpeechFailed={handleSpeechFailed}
        autoStart
        fullBody
        poster="/avatar-poster-stage.jpg"
      />

      {/* 加了 ?debug=1 才會出現。平常一個像素都不佔。 */}
      <TracePanel />

      {/* 頂部：身分標記。這一頁沒有 Nav，所以必須自己放。 */}
      <header className="absolute inset-x-0 top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-ink/85 to-transparent px-4 pb-10 pt-4 sm:px-6">
        {/* AVATAR_NAME 已經帶著「（AI 模擬）」，不需要第二個標記 */}
        <span className="font-display text-[15px] font-bold sm:text-[17px]">{AVATAR_NAME}</span>
        <Link
          href="/chat"
          className="ml-auto rounded-full border border-white/35 px-3 py-1 text-[12px] font-bold transition-colors hover:bg-white/10"
        >
          {liveCopy.fallbackLink}
        </Link>
      </header>

      {/* 底部：字幕、免責、按鈕、揭露 */}
      {/*
        ⚠️ `paddingBottom` 帶 `env(safe-area-inset-bottom)`：按鈕原本 pb-5 貼著
        畫面下緣，在 iPhone 上剛好落在 home indicator 那一帶——那是手勢區，
        單手拇指按下去有一半機率被系統吃掉，這是「不好按」的另一半原因。
        ⚠️ 漸層的 pt 跟著加高（16 → 20），不然按鈕上移之後會浮在她小腿中間。
      */}
      <div
        className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-ink via-ink/85 to-transparent px-4 pt-20 sm:px-6"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.75rem)" }}
      >
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 text-center">
          {/*
            ⚠️ 這一行原本是 13px、55% 白，壓在 17~20px 的答案上方——等於沒有。
            user 的原話：「畫面上要出現已輸入的問題文字，這樣民眾才知道自己問了什麼」。
            所以做成看得出是「你剛剛說的話」的泡泡，跟她的答案在視覺上分開。

            ⚠️ 出現的**時機**不要動：逐字稿在放開後約 1.8 秒才會到（/api/stt 的往返），
            那段空窗由「聽你說…」處理。要更早就得引入第二套辨識，已經定案不做。
          */}
          {heard && (
            <p className="max-w-[92%] rounded-2xl bg-white/12 px-4 py-2 text-[15px] leading-snug text-white/90 sm:text-[17px]">
              <span className="mr-1.5 text-white/50">你問</span>
              {heard}
            </p>
          )}

          {/* min-h 讓字幕出現／消失時按鈕不會跳動 */}
          <div className="flex min-h-[3.5rem] items-center justify-center sm:min-h-[4rem]">
            {/* ⚠️ 答案優先於提示。反過來的話，「聲音沒出來」這種提示會**蓋掉**
                它正在說「在上面」的那段答案——訪客只剩一句沒有指涉對象的錯誤訊息。 */}
            {answer ? (
              <p className="text-[17px] leading-relaxed sm:text-[20px]">{answer}</p>
            ) : notice ? (
              <p className="text-[15px] text-brand-soft sm:text-[17px]">{notice}</p>
            ) : (
              <p className="text-[15px] text-white/60 sm:text-[17px]">
                {statusLine || liveCopy.ready}
              </p>
            )}
          </div>

          {/* ⚠️ 護欄 3：這一句在 /chat 是逐則附加的，這裡沒有訊息泡泡，所以常駐。 */}
          {answer && (
            <p className="text-[11px] text-white/45 sm:text-[12px]">{ANSWER_DISCLAIMER}</p>
          )}

          {/* 答案與提示同時存在時，提示走小字掛在下面，不搶答案的位置 */}
          {answer && notice && (
            <p className="text-[12.5px] text-brand-soft sm:text-[13.5px]">{notice}</p>
          )}

          <button
            type="button"
            // 🔴 只綁 onClick。
            //
            // 前一版是 onPointerDown 開始 / onPointerUp 送出（按住說話），連帶還有
            // 一段 try/catch 包著的 setPointerCapture。那一整套已經拿掉了，理由：
            //
            // 1. 手滑。手指移開按鈕範圍一點點就送出半句話，而 setPointerCapture
            //    只能減輕不能消除（它自己也會丟 NotFoundError）。
            // 2. 每個新訪客的第一次都注定失敗——按住會跳麥克風權限詢問，
            //    要按「允許」就必須先放開按鈕（見 liveCopy.micNeedsAllow）。
            // 3. 🔴 **鍵盤完全按不到這顆按鈕。** Enter/Space 觸發的是 click，
            //    不會產生 pointer 事件，所以舊版對鍵盤使用者是死的。改成
            //    onClick 順手修掉這件事，不需要另外寫 onKeyDown。
            //
            // ⚠️ 不要「順手」把 pointer 事件加回來當備援——click 在觸控上本來就
            // 由 pointer 事件合成，兩套一起綁會讓每一下變成兩次。
            onClick={toggle}
            // 長按在行動裝置上會跳出選單。切換式已經不需要 pointerup，
            // 但選單彈出來會遮住畫面、也讓人以為按錯了，所以還是擋掉。
            onContextMenu={(event) => event.preventDefault()}
            disabled={isBusy(state)}
            aria-pressed={recording}
            className={[
              // ⚠️ 尺寸是刻意放大的：原本 px-10 py-4（約 52px 高）貼在畫面下緣，
              // 使用者回報「不好按、會手滑」。現在最小 64px 高，寬度也給足。
              "min-h-16 touch-none select-none rounded-full px-12 py-5 font-display text-[19px] font-bold",
              "transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45",
              recording
                ? "scale-105 bg-white text-ink"
                : "bg-brand text-white hover:brightness-110 active:scale-95",
            ].join(" ")}
            // ⚠️ 長按不要跳 iOS 的「拷貝／查詢」氣泡。Tailwind 的 select-none
            // 只管文字選取，這個屬性才管那個氣泡。
            style={{ WebkitTouchCallout: "none" }}
            // ⚠️ 這裡原本有一圈跟著音量脹縮的 boxShadow。音量計做出來之後把它拿掉了：
            // 它會擴散 44px，剛好把下面那排柱子糊在自己的灰影裡（實測截圖確認），
            // 而且兩個東西同時跟著音量跳只是噪音。證明「聲音有進來」的工作交給音量計，
            // 它畫的是真的送進 WAV 的取樣，比一圈光暈精確也好懂。
          >
            {recording ? liveCopy.talkRecording : liveCopy.talkIdle}
          </button>

          {/*
            ⚠️ 這裡刻意**不**寫「還沒收到聲音，講大聲一點」那種判斷句。
            實測底噪就有 0.007、而說話的瞬時值在字與字之間會掉回底噪，
            任何絕對門檻都會在使用者正常講話時反覆喊「沒收到」——冤枉人又嚇人。

            證明「聲音有進來」的工作交給音量計：它畫的是真的送進 WAV 的那些取樣，
            不是一個猜測。真正沒收到（麥克風被靜音）會在放開之後由 SILENCE_RMS 抓到並明說。
          */}
          {recording && (
            <div className="flex flex-col items-center gap-2">
              {/* 音量計本身是純視覺，讀屏不需要唸它 */}
              <div className="flex h-7 items-center gap-[3px]" aria-hidden="true">
                {METER_BARS.map((factor, i) => (
                  <span
                    key={i}
                    className="w-[3px] rounded-full bg-white/85"
                    style={{
                      height: `${meterBarHeight(level, factor).toFixed(1)}px`,
                      transition: "height 90ms linear",
                    }}
                  />
                ))}
              </div>
              {/*
                ⚠️ 最後 10 秒改成倒數，不是繼續往上數。
                切換式允許「按了就走開」，這個計時器是唯一的收手機制，
                所以要先講、而且要講剩幾秒——被無預警切斷的人只會以為壞了。
                （按住式不需要這麼早提醒，因為手一放就結束了。）
              */}
              <p className="text-[12.5px] text-white/60" aria-live="polite">
                {nearCap ? liveCopy.recordingNearCap : liveCopy.recordingHint}
                {/* 秒數不進 aria-live——每秒唸一次數字對讀屏使用者是噪音 */}
                <span aria-hidden="true" className="ml-2 tabular-nums text-white/45">
                  {nearCap
                    ? `還有 ${Math.max(0, Math.ceil(MAX_RECORDING_SECONDS - elapsed))} 秒`
                    : `${Math.floor(elapsed)} 秒`}
                </span>
              </p>
            </div>
          )}

          {/* Footer 也是每頁自己掛的，這一頁沒掛，所以揭露要自己放 */}
          <p className="max-w-2xl text-[10px] leading-snug text-white/35 sm:text-[11px]">
            {SITE_NOTICE}
          </p>
        </div>
      </div>
    </div>
  );
}
