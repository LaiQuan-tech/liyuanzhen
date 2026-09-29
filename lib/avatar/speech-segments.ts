/**
 * 長答案的朗讀：切成 `/api/tts` 收得下的段落，再把各段的串流依序接成一條。
 *
 * 🔴 存在的理由：`/api/tts` 超過 600 字直接回 400，而 4xx 不重試——
 * 整段答案一個字都不會唸出來，畫面上只剩一句「聲音沒出來」。
 * persona 規則把回答壓在 100 字左右，但那是 prompt 不是硬限制，
 * 危機延續的專線救援、模型偶爾的長回答都可能超過。
 *
 * ⚠️ 每多一段就多打一次 `/api/tts`，也就多吃一格限流（lib/rate-limit.ts 的 ttsRateLimit：
 * 每 IP 每分鐘 20、每天 200，全站每日總量 4000 跨端點共用）。所以段落要**盡量塞滿**
 * 而不是一句一段：100 字的正常答案只打一次，1,200 字的長答案打三次。
 * 下一段也是等上一段的串流收完才去要（見 sequenceSpeechStreams），不會一口氣全送出去。
 */

/**
 * `app/api/tts/route.ts` 的 `MAX_TEXT_CHARS`。
 *
 * ⚠️ 抄一份而不 import：那支 route 會把 lib/voice（伺服器端、讀金鑰）一起拉進瀏覽器 bundle。
 * 兩邊一致由 speech-segments.test.ts 讀 route 原始碼比對，改一邊測試就會紅。
 *
 * ⚠️ 單位是 UTF-16 code unit，不是「字」：route 用 `text.length` 比，
 * 一個擴充區漢字或 emoji（代理對）算 2。這裡所有長度也都用 `.length` 量。
 */
export const TTS_MAX_CHARS = 600;

/**
 * 每段實際切多長。🔴 刻意比 600 小。
 *
 * `/api/tts` 的 `maxDuration = 60` 秒是照「500 字 ≈ 100 秒語音、v3_conversational
 * 約 2.25 倍實時 ≈ 45 秒生成」訂的（見 route 註解）。一段塞到 600 字就是 ≈ 53 秒生成
 * ＋ 首字 3.6 秒，貼著 60 秒的線——稍慢一點就會在段落中間被平台切斷，
 * 症狀是「念到一半沒聲音」，比整段失敗還難查。
 */
export const SPEECH_SEGMENT_CHARS = 500;

/** 句界：句號、問號、驚嘆號、分號、刪節號、換行（全形半形都算）。 */
const SENTENCE_ENDS = new Set(["。", "！", "？", "!", "?", "；", ";", "…", "\n"]);
/**
 * 句末標點後面緊跟的收尾符號要黏在同一句：「她說：『好。』」要切在 』 後面，
 * 不是切在 。 與 』 中間——後者會讓下一段開頭是一個孤零零的引號。
 * ⚠️ 不收半形句點 `.`：中文答案裡它幾乎只出現在數字（1.5）與縮寫，切下去會把數字切斷。
 */
const CLOSERS = new Set(["」", "』", "”", "’", '"', "'", "）", ")", "】", "〕", "》", "〉", "］", "]"]);
/** 單句就超過上限時，退而求其次的切點。 */
const CLAUSE_ENDS = new Set(["，", "、", "：", ",", ":", " ", "　", "\t"]);

/**
 * 在 `ends` 裡的字元之後切開（連續的結尾字元與收尾符號黏在前一塊）。
 * ⚠️ 用 Array.from 逐 code point 走，代理對不會被拆開——不要改成 `text[i]` 逐 code unit。
 */
function splitAfter(text: string, ends: Set<string>): string[] {
  const out: string[] = [];
  let current = "";
  let closing = false;
  for (const ch of Array.from(text)) {
    if (closing && !ends.has(ch) && !CLOSERS.has(ch)) {
      out.push(current);
      current = "";
      closing = false;
    }
    current += ch;
    if (ends.has(ch)) closing = true;
  }
  if (current) out.push(current);
  return out;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * 最後手段：整串沒有任何標點，只能照長度硬切。
 * 🔴 切點落在代理對中間（高位在左、低位在右）就往前退一格——
 * 拆開的半個代理對送到 ElevenLabs 會變成亂碼，嚴重時整段 400。
 */
function hardSplit(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = max;
    if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/** 把小塊依序塞進 ≤ max 的段落，塞不下才開新的一段 */
function pack(pieces: string[], max: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length > max) {
      out.push(current);
      current = "";
    }
    current += piece;
  }
  if (current) out.push(current);
  return out;
}

/**
 * 把一段答案切成依序朗讀的段落。
 *
 * - 每段 `.length` ≤ `maxChars`（預設 500，永遠 ≤ TTS_MAX_CHARS）
 * - 切點優先落在句界（。！？；…換行，連同後面的 」』） 等收尾符號）
 * - 單句本身就超長時才退到逗號、頓號、冒號、空白；再不行才硬切，而且不拆代理對
 * - 段落頭尾的空白去掉，空段丟掉；空字串回 []
 */
export function splitForSpeech(text: string, maxChars: number = SPEECH_SEGMENT_CHARS): string[] {
  // 至少 2：硬切遇到代理對要能整個放進去，不然會卡在原地切出空段
  const max = Math.max(2, Math.min(Math.floor(maxChars), TTS_MAX_CHARS));
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];

  const pieces: string[] = [];
  for (const sentence of splitAfter(clean, SENTENCE_ENDS)) {
    if (sentence.length <= max) {
      pieces.push(sentence);
      continue;
    }
    for (const clause of splitAfter(sentence, CLAUSE_ENDS)) {
      if (clause.length <= max) pieces.push(clause);
      else pieces.push(...hardSplit(clause, max));
    }
  }
  return pack(pieces, max)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * 把各段的 TTS 串流依序接成**一條**，交給一次 `LipSyncPlayer.play()`。
 *
 * 🔴 為什麼不是一段一段呼叫 `play()`：`play()` 一開頭會 `stop()` 上一段，而它在
 * **串流收完**時就 resolve，不是在聲音播完時（ElevenLabs 約 2.25 倍實時，一段 100 秒的話
 * 45 秒就收完，後面 55 秒的音訊還排在播放圖上）。一段一段 play 等於每段都把上一段的後半截切掉。
 * 接成一條之後，下一段的第一塊會被 LipSyncPlayer 排在上一段最後一塊的正後方，段與段之間沒有縫。
 *
 * - 下一段等上一段的串流**收完**才去要，不是一開始就全部送出：限流一次只佔一格，
 *   被打斷時也不會有一串已經送出、白花額度的請求。上一段還有大半截在播，
 *   下一段 3～4 秒的首字延遲藏得住。
 * - 某一段拿不到或讀到一半斷掉：**不丟錯**，照常收尾（已經排進去的讓它唸完），
 *   改呼叫 `onFailure` 讓呼叫端在唸完之後告訴訪客。第一段就失敗的話整條是空的，
 *   呼叫端會看到一個取樣都沒收到。
 * - 某一段的位元組數是奇數（不該發生，PCM 一定是偶數）就補一個 0 湊滿半個取樣，
 *   否則下一段的每一個取樣都會錯位一格——整段變成刺耳雜訊，而且不會有任何錯誤。
 * - 被 cancel（LipSyncPlayer.stop() 之後它會 cancel 讀取端）就把手上那一段也 cancel 掉。
 * - `onChunk` 在每一塊交出去之前呼叫，給呼叫端的看門狗重新計時（見 monogram.ts 的 STALL_TIMEOUT_MS）。
 */
export function sequenceSpeechStreams(
  segments: readonly string[],
  open: (text: string, index: number) => Promise<ReadableStream<Uint8Array>>,
  onFailure: (index: number, error: unknown) => void,
  onChunk?: () => void
): ReadableStream<Uint8Array> {
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let oddBytes = false;
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (cancelled) return;

        if (!reader) {
          if (index >= segments.length) {
            controller.close();
            return;
          }
          let body: ReadableStream<Uint8Array>;
          try {
            body = await open(segments[index], index);
          } catch (error) {
            if (cancelled) return;
            onFailure(index, error);
            controller.close();
            return;
          }
          if (cancelled) {
            body.cancel().catch(() => {});
            return;
          }
          reader = body.getReader();
          oddBytes = false;
        }

        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (error) {
          reader = null;
          if (cancelled) return;
          onFailure(index, error);
          controller.close();
          return;
        }
        if (cancelled) return;

        if (result.done) {
          reader = null;
          if (oddBytes) controller.enqueue(new Uint8Array(1));
          index++;
          continue;
        }
        const chunk = result.value;
        if (chunk && chunk.byteLength > 0) {
          if (chunk.byteLength % 2 === 1) oddBytes = !oddBytes;
          onChunk?.();
          controller.enqueue(chunk);
          return;
        }
      }
    },

    cancel(reason) {
      cancelled = true;
      const current = reader;
      reader = null;
      return current?.cancel(reason).catch(() => {});
    },
  });
}
