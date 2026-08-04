"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import DigitalAvatar, { type AvatarState } from "@/components/avatar/DigitalAvatar";
import { Speaker } from "@/lib/tts";
import { ANSWER_DISCLAIMER } from "@/content/site";
import { OPENING_QUESTIONS } from "@/content/suggested-questions";

interface Message {
  role: "user" | "model";
  text: string;
}

export default function ChatPanel({ initialQuestion }: { initialQuestion?: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [avatarState, setAvatarState] = useState<AvatarState>("idle");
  const [voiceOn, setVoiceOn] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);

  const sessionIdRef = useRef<string>("");
  const speakerRef = useRef<Speaker | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentInitial = useRef(false);

  useEffect(() => {
    sessionIdRef.current =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now());

    const speaker = new Speaker();
    speakerRef.current = speaker;
    speaker.init((state) => {
      setAvatarState((prev) => (prev === "thinking" ? prev : state === "speaking" ? "speaking" : "idle"));
    }).then(setVoiceAvailable);

    // 預熱 lambda：冷啟動的 3~5 秒靜默是提案現場最尷尬的時刻
    fetch("/api/health").catch(() => {});

    return () => speaker.stop();
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
      setAvatarState("thinking");

      const speaker = speakerRef.current;
      speaker?.stop();
      speaker?.reset();

      const history = [...messages, { role: "user" as const, text: question }];
      setMessages([...history, { role: "model", text: "" }]);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sessionIdRef.current, messages: history }),
        });

        if (!response.ok || !response.body) {
          const fallback = await response.text().catch(() => "抱歉，我這邊出了點狀況。");
          setMessages([...history, { role: "model", text: fallback }]);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let answer = "";
        let spoke = false;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const delta = decoder.decode(value, { stream: true });
          answer += delta;

          if (voiceOn && voiceAvailable) {
            if (!spoke) spoke = true;
            speaker?.push(delta);
          }
          setMessages([...history, { role: "model", text: answer }]);
        }

        if (voiceOn && voiceAvailable) speaker?.flush();
        if (!spoke) setAvatarState("idle");
      } catch {
        setMessages([...history, { role: "model", text: "連線好像不太穩，請再試一次。" }]);
      } finally {
        setBusy(false);
        if (!(voiceOn && voiceAvailable)) setAvatarState("idle");
      }
    },
    [busy, messages, voiceOn, voiceAvailable]
  );

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
          <DigitalAvatar state={avatarState} size="sm" />
        </div>
        <div className="flex items-center gap-2">
          {voiceAvailable ? (
            <button
              type="button"
              onClick={() => {
                const next = !voiceOn;
                setVoiceOn(next);
                if (!next) speakerRef.current?.stop();
              }}
              className="lz-chip"
              aria-pressed={voiceOn}
            >
              {voiceOn ? "🔊 朗讀中" : "🔈 開啟朗讀"}
            </button>
          ) : (
            <span className="text-[12px] text-muted-light">此裝置無中文語音</span>
          )}
          {avatarState === "speaking" && (
            <button
              type="button"
              onClick={() => {
                speakerRef.current?.stop();
                setAvatarState("idle");
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
