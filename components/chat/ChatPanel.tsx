"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AvatarStage, { type AvatarStageHandle } from "@/components/avatar/AvatarStage";
import { deriveAvatarState, speakableAnswer } from "@/lib/avatar";
import { ANSWER_DISCLAIMER, TAIL_REPLIES, liveCopy } from "@/content/site";
import { OPENING_QUESTIONS } from "@/content/suggested-questions";

interface Message {
  role: "user" | "model";
  text: string;
}

export default function ChatPanel({ initialQuestion }: { initialQuestion?: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  /**
   * 這個瀏覽器放不放得出老師的聲音。null ＝ driver 還沒回報：
   * 那段時間什麼都不顯示，不要先秀一句「無法播放」再變成按鈕。
   */
  const [voiceAvailable, setVoiceAvailable] = useState<boolean | null>(null);
  /**
   * 哪一則回答的聲音沒出來（訊息索引）。提示掛在那一則的免責句下面，答案本身不動——
   * 跟 /live 的 handleSpeechFailed 同一個規則：提示不可以蓋掉它正在說「在上面」的那段答案。
   */
  const [voiceFailedAt, setVoiceFailedAt] = useState<number | null>(null);

  // 不要把它改回 useState。理由寫在 deriveAvatarState 的註解裡。
  const avatarState = deriveAvatarState(speaking, busy);

  const sessionIdRef = useRef<string>("");
  const stageRef = useRef<AvatarStageHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentInitial = useRef(false);
  /**
   * 🔴 朗讀開關的**即時**值。send() 是 useCallback，閉包裡的 voiceOn 是送出那一刻的值——
   * 答案串流到一半關掉朗讀的話，舊閉包仍然是 true，串流結束時照樣 finish()，
   * 訪客剛關掉的聲音又自己念起來。所以串流中與串流後的判斷一律讀這個 ref。
   */
  const voiceOnRef = useRef(false);
  /** 正要唸的是哪一則（訊息索引），onSpeechFailed 用它決定提示掛在哪裡 */
  const speakingIndexRef = useRef<number | null>(null);

  useEffect(() => {
    sessionIdRef.current =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now());

    // 預熱 lambda：冷啟動的 3~5 秒靜默是提案現場最尷尬的時刻
    // ⚠️ 要打 /api/chat 自己，不要打 /api/health——後者在正式站被 Vercel
    // 邊緣快取（實測 x-vercel-cache: HIT），請求到不了任何 lambda。
    // 而且每一支 route 在 Vercel 上是獨立的 function，熱了一支不代表熱了另一支。
    void fetch("/api/chat", { method: "GET" }).catch(() => {});
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || busy) return;

      setInput("");
      setBusy(true);
      setVoiceFailedAt(null);

      // 上一題還在唸的話先閉嘴；合成請求還在飛的話一起取消（driver.stop 兩件都做）
      stageRef.current?.stop();
      // 🔴 這一下送出就是使用者手勢，而且必須在任何 await 之前。朗讀要等整段答案才開口，
      // 那時早就離開手勢了——AudioContext 只能在這裡解鎖或 resume（iOS 切到背景再回來會被暫停，
      // 不能只靠「開啟朗讀」那一下）。只在朗讀開著時做：深連結 ?q= 自動送出不是手勢，
      // 而那時朗讀一定是關的（預設關）。
      if (voiceOnRef.current) stageRef.current?.unlockAudio?.();

      const history = [...messages, { role: "user" as const, text: question }];
      /** 這一題的回答會落在哪個索引 */
      const answerIndex = history.length;
      setMessages([...history, { role: "model", text: "" }]);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // channel 只給後台的問答紀錄用，讓「打字問的」跟「講話問的」分得開。
          // 到了 /api/chat 這一層，語音提問已經被 /api/stt 轉成純文字了，
          // 不明講的話兩者一模一樣。
          body: JSON.stringify({
            sessionId: sessionIdRef.current,
            messages: history,
            channel: "chat",
          }),
        });

        if (!response.ok || !response.body) {
          const fallback = await response.text().catch(() => "抱歉，我這邊出了點狀況。");
          setMessages([...history, { role: "model", text: fallback }]);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let answer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const delta = decoder.decode(value, { stream: true });
          answer += delta;

          // 現在每個 driver 都等整段答案才開口，會忽略它。留著是因為 AvatarStage 的 push
          // 會順手回報活動，串流虛擬人（heygen）的閒置計時器靠它知道使用者還在。
          if (voiceOnRef.current) stageRef.current?.push(delta);
          setMessages([...history, { role: "model", text: answer }]);
        }

        // ⚠️ 一定要送 speakableAnswer 而不是 answer：answer-guard 命中封鎖清單時
        //    會停止輸出剩餘文字、在後面追加婉拒句。照著整段唸就會把系統認定
        //    不該說的那段用她的臉和聲音講出去。
        //    route 會接在半段後面的句子不只一種（封鎖清單 GUARDED_REPLY、隱私 PRIVACY_REPLY、
        //    落地失敗 UNGROUNDED_REPLY、生成失敗 FALLBACK_REPLY、危機延續與專線救援、同理備援 VENTING_REPLY），
        //    全部列在 content/site.ts 的 TAIL_REPLIES，每一種都要檢查有沒有回收——
        //    少認一種，那種情境下超過 140 字緩衝而先吐出的半段就會漏網被唸出去。
        //
        //    ⚠️ 讀 voiceOnRef 不讀 voiceOn：串流途中關掉朗讀的話，這裡就不能再開口（見 voiceOnRef）。
        if (voiceOnRef.current) {
          const toSpeak = TAIL_REPLIES.reduce((text, reply) => speakableAnswer(text, reply), answer);
          speakingIndexRef.current = answerIndex;
          stageRef.current?.finish(toSpeak);
        }
      } catch {
        setMessages([...history, { role: "model", text: "連線好像不太穩，請再試一次。" }]);
      } finally {
        // 串流結束不代表講完了——朗讀還在跑時 speaking 仍為 true，
        // 推導出來就會是 speaking 而不是 idle，不需要在這裡特判。
        setBusy(false);
      }
    },
    [busy, messages]
  );

  /**
   * 這一則的聲音沒出來（合成重試用盡、網路斷、429、AudioContext 沒解鎖）。
   * 🔴 不會退回裝置語音——全站只剩老師一種聲音，寧可明講這次沒唸出來。
   */
  const handleSpeechFailed = useCallback(() => {
    setVoiceFailedAt(speakingIndexRef.current);
  }, []);

  // 深連結：/chat?q=… 自動送出，讓時間軸與金句卡可以直接把問題帶進來
  useEffect(() => {
    if (initialQuestion && !sentInitial.current && sessionIdRef.current) {
      sentInitial.current = true;
      void send(initialQuestion);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);

  return (
    <div className="lz-device flex h-[min(74vh,620px)] flex-col">
      {/* 頂部：頭像與語音開關 */}
      <div className="flex items-center justify-between gap-3 border-b-2 border-ink bg-paper-tint px-4 py-3">
        <div className="flex items-center gap-3">
          <AvatarStage
            ref={stageRef}
            state={avatarState}
            size="sm"
            onSpeakingChange={setSpeaking}
            onAudioAvailableChange={setVoiceAvailable}
            onSpeechFailed={handleSpeechFailed}
          />
        </div>
        <div className="flex items-center gap-2">
          {voiceAvailable === true ? (
            <button
              type="button"
              onClick={() => {
                const next = !voiceOnRef.current;
                voiceOnRef.current = next;
                setVoiceOn(next);
                if (next) {
                  // 🔴 第一行、同步：這一下點擊就是解鎖 AudioContext 的手勢
                  //    （老師的聲音走 Web Audio，見 AvatarStageHandle.unlockAudio）。
                  stageRef.current?.unlockAudio?.();
                  // ⚠️ 設成串流虛擬人（NEXT_PUBLIC_AVATAR_PROVIDER=heygen）時，這一下也是
                  //    串流開始計費的那一刻。刻意不放在 useEffect 裡：StrictMode 會讓 effect
                  //    跑兩次，等於開兩個計費 session。
                  void stageRef.current?.prepare();
                } else {
                  // 關掉就要真的安靜：正在唸的停掉、還在飛的合成請求取消（driver.stop 兩件都做）。
                  // 串流還沒結束的那一則也不會再開口——send() 讀的是 voiceOnRef。
                  stageRef.current?.stop();
                }
              }}
              className="lz-chip"
              aria-pressed={voiceOn}
            >
              {voiceOn ? "🔊 朗讀中" : "🔈 開啟朗讀"}
            </button>
          ) : voiceAvailable === false ? (
            // 聲音是伺服器合成的，瀏覽器只負責播放；走到這裡代表它沒有 Web Audio
            <span className="text-[12px] text-muted-light">此瀏覽器無法播放語音</span>
          ) : null}
          {avatarState === "speaking" && (
            <button
              type="button"
              onClick={() => {
                stageRef.current?.stop(); // driver 會自己回報停止發聲
                setSpeaking(false); // driver 還沒建好時的保險，冪等
              }}
              className="lz-chip"
            >
              停止
            </button>
          )}
        </div>
      </div>

      {/* 訊息區 */}
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-5">
        {messages.length === 0 && (
          <div className="space-y-4">
            <div className="lz-bubble-her max-w-[86%] text-[15px]">
              您好，我是依公開資料建立的「數位李元貞」。您可以問我台灣婦女運動的歷史，
              或李元貞老師的生平與著作。
            </div>
            <div className="flex flex-wrap gap-2">
              {OPENING_QUESTIONS.map((q) => (
                <button key={q} type="button" className="lz-chip" onClick={() => void send(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={msg.role === "user" ? "flex justify-end" : "flex justify-start"}
          >
            <div className="max-w-[86%]">
              <div
                className={
                  msg.role === "user"
                    ? "lz-bubble-me text-[15px]"
                    : "lz-bubble-her text-[15px]"
                }
              >
                {msg.text || (
                  <span className="inline-flex gap-1" aria-label="思考中">
                    {[0, 1, 2].map((d) => (
                      <span
                        key={d}
                        className="h-1.5 w-1.5 rounded-full bg-ink/40 animate-bounce"
                        style={{ animationDelay: `${d * 140}ms` }}
                      />
                    ))}
                  </span>
                )}
              </div>
              {/* 每一則 AI 回答都必須附上免責句，不可省略 */}
              {msg.role === "model" && msg.text && (
                <p className="mt-1.5 px-1 text-[11.5px] leading-snug text-muted-light">
                  {ANSWER_DISCLAIMER}
                </p>
              )}
              {/* 聲音沒出來的提示：文案與版位照 /live（LiveStage 的 handleSpeechFailed）——
                  小字掛在答案與免責句**下面**，不取代答案，因為它說的就是「答案在上面」。 */}
              {msg.role === "model" && msg.text && i === voiceFailedAt && (
                <p role="status" className="mt-1 px-1 text-[11.5px] leading-snug text-brand">
                  {liveCopy.voiceFailed}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 輸入區 */}
      <form
        className="flex items-center gap-2 border-t-2 border-ink bg-white px-3 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={300}
          placeholder="想問什麼都可以…"
          className="min-w-0 flex-1 rounded-full border-[1.5px] border-ink bg-paper px-4 py-2.5 text-[15px] outline-none placeholder:text-muted-light"
          aria-label="輸入問題"
        />
        <button type="submit" disabled={busy || !input.trim()} className="lz-cta shrink-0 disabled:opacity-40">
          {busy ? "…" : "送出"}
        </button>
      </form>
    </div>
  );
}
