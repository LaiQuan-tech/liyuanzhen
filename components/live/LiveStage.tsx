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
} from "@/lib/live/recorder";
import { METER_BARS, meterBarHeight, smoothLevel } from "@/lib/live/level";
import {
  deriveLiveState,
  avatarStateFor,
  canStartRecording,
  isBusy,
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
const CHAT_TIMEOUT_MS = 20_000;

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
 * 全螢幕的數位李元貞。按住說話，她用自己的聲音與臉回答。
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

  const state = deriveLiveState({ recording, phase, speaking, errored: Boolean(notice) });

  useEffect(() => {
    sessionIdRef.current =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now());

    // 預熱 lambda：冷啟動的 3~5 秒靜默是提案現場最尷尬的時刻
    fetch("/api/health").catch(() => {});

    const recorder = createRecorder(
      () => {
        // 按住不放撞到 30 秒上限。當成放開處理，不要無聲地丟掉他講的話。
        autoStopRef.current();
      },
      // 即時音量。⚠️ 一定要走 smoothLevel（峰值保持 ＋ 衰減），不要直接餵瞬時值：
      // 人講話字與字之間本來就有停頓，瞬時值會掉到底噪，音量計就會塌成一排點。
      (rms) => setLevel((prev) => smoothLevel(prev, rms))
    );
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
    const id = setInterval(() => setElapsed((Date.now() - startedAt) / 1000), 200);
    return () => clearInterval(id);
  }, [recording]);

  /** 跑完一輪：逐字稿 → RAG ＋ 生成 → 她開口 */
  const runTurn = useCallback(async (wav: Uint8Array) => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setNotice(liveCopy.offline);
      return;
    }

    setPhase("transcribing");
    try {
      const sttResponse = await withTimeout(
        fetch("/api/stt", {
          method: "POST",
          headers: { "Content-Type": "audio/wav" },
          body: new Blob([wav as BlobPart], { type: "audio/wav" }),
        }),
        STT_TIMEOUT_MS
      );

      if (!sttResponse.ok) {
        setNotice(liveCopy.notHeard);
        return;
      }
      const { transcript } = (await sttResponse.json()) as { transcript?: string };
      // ⚠️ 空字串**不可以**安靜地忽略。
      // 這裡收到空字串代表使用者真的按住、真的講了（太短的誤觸在 recorder.stop()
      // 就回 null 了，根本到不了這裡），只是辨識不出內容。
      // 原本寫「安靜地什麼都不做」，實際症狀就是使用者回報的「說話沒有反應」——
      // 按了、講了、放開，畫面一個字都沒變，他無法分辨是自己的問題還是網站壞了。
      if (!transcript) {
        setNotice(liveCopy.heardNothing);
        return;
      }

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
          body: JSON.stringify({ sessionId: sessionIdRef.current, messages: history }),
        }),
        CHAT_TIMEOUT_MS
      );

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
        if (done) break;
        full += decoder.decode(value, { stream: true });
        setAnswer(full);
      }
      full += decoder.decode();

      messagesRef.current = [...history, { role: "model", text: full }];
      setAnswer(full);
      stageRef.current?.reportActivity();

      // ⚠️ 護欄 2：送 speakableAnswer，不是 full。
      stageRef.current?.finish(speakableAnswer(full, GUARDED_REPLY));
    } catch (error) {
      console.error("[live] 這一輪失敗：", error);
      setNotice(liveCopy.failed);
    } finally {
      setPhase("idle");
    }
  }, []);

  /** 放開按鈕（或撞到錄音上限）→ 收音、送出 */
  const release = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;

    setRecording(false);
    const outcome = await recorder.stop();

    // ⚠️ 這一支要**第一個**判斷，而且必須跟 tooShort 分開。
    // 按住夠久卻一塊音訊都沒收到 ＝ 錄音管線死掉，不是誤觸。
    // 合在一起的那一版真的上線過：使用者按住講了一秒，畫面回他「按住不放」。
    if (outcome.kind === "no-audio") {
      setNotice(liveCopy.micDead);
      return;
    }

    // 誤觸，或放得比 getUserMedia 還快。給一句提示就好，不要當成錯誤。
    if (outcome.kind !== "ok") {
      setNotice(liveCopy.tooShort);
      return;
    }

    // 有錄到但整段都在底噪之下——麥克風沒開、被靜音、或講得太小聲。
    // ⚠️ 在這裡就擋下來，不要送去 /api/stt：伺服器只會回一個空字串，
    // 而「沒收到聲音」跟「聽不出內容」對使用者是完全不同的兩件事。
    if (outcome.peak < SILENCE_RMS) {
      setNotice(liveCopy.noSound);
      return;
    }

    await runTurn(outcome.wav);
  }, [runTurn]);

  autoStopRef.current = () => void release();

  /** 按下按鈕 → 開串流（第一次）＋ 開麥克風 */
  const press = useCallback(async () => {
    if (!canStartRecording(state)) return;

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

    try {
      await recorderRef.current?.start();
      setRecording(true);
    } catch (error) {
      setRecording(false);
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
          poster 是 avatar 的來源照片（真實攝影），為什麼不掛浮水印見 AvatarStage 的 props 註解。 */}
      <AvatarStage
        ref={stageRef}
        state={avatarStateFor(state)}
        size="full"
        provider={LIVE_PROVIDER}
        onSpeakingChange={setSpeaking}
        onTeardown={handleTeardown}
        onSpeechFailed={handleSpeechFailed}
        autoStart
        poster="/avatar-poster.jpg"
      />

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
      <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-ink via-ink/85 to-transparent px-4 pb-5 pt-16 sm:px-6">
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
            // Pointer Events 一套搞定滑鼠與觸控。
            // setPointerCapture：手指按住之後滑出按鈕範圍，pointerup 仍然收得到——
            // 少了它，使用者一邊講一邊手滑，麥克風就永遠關不掉。
            onPointerDown={(event) => {
              // ⚠️ setPointerCapture 會在 pointerId 已經不是「作用中的指標」時
              // 丟 NotFoundError。它原本是這個 handler 的第一行，例外一丟，
              // 下面的 press() 整個不會執行——按鈕靜默失效，畫面上一點反應都沒有，
              // 也沒有任何錯誤訊息。實測時真的踩到。
              //
              // 指標捕捉只是「手指滑出按鈕範圍仍收得到 pointerup」的優化，
              // 不是錄音的前提條件。它失敗就算了，不可以拖著錄音一起死。
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                // 沒捕捉到就沒捕捉到，pointerup 仍然會在按鈕上觸發
              }
              void press();
            }}
            onPointerUp={() => void release()}
            onPointerCancel={() => void release()}
            // 長按在行動裝置上會跳出選單，把 pointerup 吃掉
            onContextMenu={(event) => event.preventDefault()}
            disabled={isBusy(state)}
            aria-pressed={recording}
            className={[
              "touch-none select-none rounded-full px-10 py-4 font-display text-[17px] font-bold",
              "transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45",
              recording
                ? "scale-105 bg-white text-ink"
                : "bg-brand text-ink hover:brightness-105 active:scale-95",
            ].join(" ")}
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
              <p className="text-[12.5px] text-white/60" aria-live="polite">
                {elapsed >= MAX_RECORDING_SECONDS - 5
                  ? liveCopy.recordingNearCap
                  : liveCopy.recordingHint}
                {/* 秒數不進 aria-live——每秒唸一次數字對讀屏使用者是噪音 */}
                <span aria-hidden="true" className="ml-2 tabular-nums text-white/45">
                  {Math.floor(elapsed)} 秒
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
