"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import ChibiAvatar from "@/components/avatar/ChibiAvatar";
import { LipSyncPlayer } from "@/lib/avatar/lipsync-player";
import type { Viseme } from "@/lib/avatar/lipsync";

/**
 * `/chibi` 的互動部分。
 *
 * ⚠️ 為什麼它不直接寫在 `page.tsx` 裡：Next.js **不准** `"use client"` 的檔案
 * `export const metadata`（build 期直接失敗，訊息是
 * 〈You are attempting to export "metadata" from a component marked with "use client"〉）。
 * 而這一頁的 `robots: { index: false }` 是硬需求，所以 `page.tsx` 必須是 server
 * component，互動的部分只能拆出來。這是 Next 的限制，不是可以合併的重複。
 */

/** ElevenLabs `output_format=pcm_24000` 的取樣率。正本在 `lib/voice/pcm.ts` */
const SAMPLE_RATE = 24_000;
const TEST_TONE_SECONDS = 3;

const DEFAULT_TEXT = "這是一段用來測試對嘴的語音，一二三四五六七八九十。";

/**
 * 在瀏覽器端合成一段「像在講話」的 PCM。完全不呼叫任何 API，所以免費。
 *
 * ⚠️ 不能用單一頻率的正弦波。連續等幅的音會讓自適應增益穩定在一個值上，
 * 嘴就固定張在某一階不動——看起來像對嘴壞掉，其實是測試訊號沒有音節。
 * 所以這裡是：載波（基頻 ＋ 兩個泛音）× 快起慢落的音節包絡，
 * 音節長短不一、響度不一，中間夾雜短停頓與偶爾的長停頓（模擬句讀）。
 * 那些停頓正是在測 `lipsync.ts` 的 RELEASE_SILENT 那條快速閉嘴曲線。
 */
function makeSpeechLikePcm(): Uint8Array {
  const totalSamples = SAMPLE_RATE * TEST_TONE_SECONDS;
  const bytes = new Uint8Array(totalSamples * 2);
  const view = new DataView(bytes.buffer);

  let cursor = 0;
  let phase = 0;

  while (cursor < totalSamples) {
    const syllable = Math.round(SAMPLE_RATE * (0.09 + Math.random() * 0.17)); // 90–260ms
    const f0 = 150 + Math.random() * 80; // 每個音節換一次基頻，不然像蜂鳴器
    const amp = 0.28 + Math.random() * 0.6;
    const n = Math.min(syllable, totalSamples - cursor);

    for (let k = 0; k < n; k++) {
      const env = Math.pow(Math.sin(Math.PI * (k / syllable)), 0.65);
      phase += (2 * Math.PI * f0) / SAMPLE_RATE;
      const carrier =
        Math.sin(phase) * 0.6 + Math.sin(phase * 2) * 0.25 + Math.sin(phase * 3) * 0.15;
      const v = Math.max(-1, Math.min(1, carrier * env * amp));
      view.setInt16((cursor + k) * 2, Math.round(v * 32_767), true);
    }
    cursor += n;

    // 音節之間的靜音；約每五個音節插一次句讀長度的停頓。緩衝區本來就是 0，跳過即可
    const longPause = Math.random() < 0.18;
    const gap = longPause ? 0.3 + Math.random() * 0.12 : 0.04 + Math.random() * 0.12;
    cursor += Math.round(SAMPLE_RATE * gap);
  }

  return bytes;
}

/**
 * 把一整段 PCM 包成 `ReadableStream`，模擬 TTS 的分塊送達。
 *
 * ⚠️ 第一塊刻意是**奇數 byte**，強迫走一次 `LipSyncPlayer` 的「半個取樣留到下一塊」
 * 分支。真實串流的切點跟 16-bit 取樣邊界沒有關係，這個分支一定會被踩到，
 * 但如果測試訊號永遠是整齊的偶數塊就永遠測不到它。
 */
function toChunkedStream(pcm: Uint8Array): ReadableStream<Uint8Array> {
  const chunkBytes = Math.round(SAMPLE_RATE * 0.12) * 2; // 約 120ms
  let offset = 0;
  let firstChunkOdd = true;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= pcm.byteLength) {
        controller.close();
        return;
      }
      let size = chunkBytes;
      if (firstChunkOdd) {
        size = chunkBytes + 1;
        firstChunkOdd = false;
      }
      const end = Math.min(offset + size, pcm.byteLength);
      controller.enqueue(pcm.subarray(offset, end));
      offset = end;
    },
  });
}

/** 打 `/api/tts`。body 的形狀跟 `app/api/tts/route.ts` 一致：`{ text: string }` */
async function fetchTtsStream(text: string): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = `${body.error}（HTTP ${res.status}）`;
    } catch {
      // 非 JSON 的錯誤回應就維持 HTTP 狀態碼
    }
    throw new Error(detail);
  }
  return res.body;
}

type Source = "local" | "tts";

export default function ChibiLab() {
  const playerRef = useRef<LipSyncPlayer | null>(null);

  const [viseme, setViseme] = useState<Viseme>("closed");
  const [level, setLevel] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(DEFAULT_TEXT);

  /**
   * 每一幀去問一次現在該是哪個嘴型。
   *
   * ⚠️ 只在值真的變了才 setState。rAF 是 60Hz，而分析器只有 25Hz——
   * 無條件 setState 等於每秒 60 次重繪換 25 次有意義的變化。
   */
  useEffect(() => {
    let raf = 0;
    let lastViseme: Viseme = "closed";
    let lastLevel = 0;
    let lastSpeaking = false;

    const tick = () => {
      const player = playerRef.current;
      if (player) {
        const state = player.currentViseme();
        const isSpeaking = player.isPlaying || state.level > 0;
        if (state.viseme !== lastViseme) {
          lastViseme = state.viseme;
          setViseme(state.viseme);
        }
        if (Math.abs(state.level - lastLevel) > 0.02) {
          lastLevel = state.level;
          setLevel(state.level);
        }
        if (isSpeaking !== lastSpeaking) {
          lastSpeaking = isSpeaking;
          setSpeaking(isSpeaking);
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  /** 卸載時收掉播放與 AudioContext，否則反覆進出這一頁會把 context 額度用光 */
  useEffect(() => {
    return () => {
      playerRef.current?.dispose();
      playerRef.current = null;
    };
  }, []);

  const run = useCallback(
    async (which: Source) => {
      if (busy) return;

      // 🔴 這一行必須在任何 await 之前。TTS 那條路要先 await fetch，
      // 等到那之後才建 AudioContext 就已經離開使用者手勢，會變成「嘴在動、沒有聲音」。
      let player = playerRef.current;
      if (!player) {
        player = new LipSyncPlayer();
        playerRef.current = player;
      }
      player.prime();

      setBusy(true);
      setError(null);
      setLatencyMs(null);
      setSource(which);

      const startedAt = performance.now();
      try {
        const stream =
          which === "local" ? toChunkedStream(makeSpeechLikePcm()) : await fetchTtsStream(text);
        await player.play(stream, () => {
          setLatencyMs(Math.round(performance.now() - startedAt));
        });
      } catch (err) {
        player.stop();
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, text]
  );

  const stop = useCallback(() => {
    playerRef.current?.stop();
    setBusy(false);
  }, []);

  return (
    <div className="grid gap-8 md:grid-cols-[260px_1fr] md:items-start">
      <div className="lz-card mx-auto w-full max-w-[260px] p-4">
        <ChibiAvatar viseme={viseme} level={level} speaking={speaking} />
      </div>

      <div className="grid gap-5">
        <div className="flex flex-wrap gap-3">
          <button type="button" className="lz-cta" onClick={() => void run("local")} disabled={busy}>
            本機測試音（免費）
          </button>
          <button
            type="button"
            className="lz-cta-ghost"
            onClick={() => void run("tts")}
            disabled={busy}
          >
            真的合成一句（會用掉 ElevenLabs 額度）
          </button>
          <button type="button" className="lz-cta-ghost" onClick={stop} disabled={!busy}>
            停止
          </button>
        </div>

        <label className="grid gap-1.5 text-sm">
          <span className="font-bold">要合成的句子（只有右邊那顆按鈕會用到）</span>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={2}
            maxLength={600}
            className="w-full resize-y rounded-xl border-2 border-ink bg-white p-3 text-[15px]"
          />
          <span className="text-xs text-muted">
            上限 600 字，跟 app/api/tts/route.ts 的 MAX_TEXT_CHARS 一致。
          </span>
        </label>

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric label="viseme" value={viseme} />
          <Metric label="level" value={level.toFixed(2)} />
          <Metric
            label="首個音訊延遲"
            value={latencyMs === null ? "—" : `${latencyMs} ms`}
            emphasis
          />
          <Metric
            label="來源"
            value={source === null ? "—" : source === "local" ? "本機" : "ElevenLabs"}
          />
        </dl>

        <p className="text-xs leading-relaxed text-muted">
          「首個音訊延遲」量的是<strong>按下按鈕到第一塊 PCM 被排進喇叭</strong>，
          不是到真的聽見聲音——排程還有一段固定前置量（LEAD_SECONDS，0.08 秒）才會出聲。
          這樣量比較誠實：前置量是我們自己加的固定成本，不該混進「伺服器多久給出第一個
          byte」裡面。
        </p>

        {error && (
          <p role="alert" className="lz-card-sm border-wine p-3 text-sm text-wine">
            失敗：{error}
          </p>
        )}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="lz-card-sm p-3">
      <dt className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</dt>
      <dd
        className={`font-display tabular-nums ${emphasis ? "text-[22px] font-extrabold" : "text-[18px] font-bold"}`}
      >
        {value}
      </dd>
    </div>
  );
}
