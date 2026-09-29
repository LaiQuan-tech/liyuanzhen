import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  SPEECH_SEGMENT_CHARS,
  TTS_MAX_CHARS,
  sequenceSpeechStreams,
  splitForSpeech,
} from "./speech-segments";

/**
 * 長答案的切段與接流。
 *
 * 🔴 守的是「答案太長就整段沒聲音」：`/api/tts` 超過 600 字回 400、4xx 不重試，
 * 所以只要有一段超過，那一段就一個字都不會唸。切錯位置（代理對中間、引號前面）
 * 不會報錯，只會念出怪聲或怪停頓——這種壞法只能靠測試擋。
 */

const ENDERS = new Set(["。", "！", "？", "!", "?", "；", ";", "…", "\n"]);
const CLOSERS = new Set(["」", "』", "”", "’", '"', "'", "）", ")", "】", "〕", "》", "〉", "］", "]"]);

/** 有沒有落單的半個代理對 */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/** 每個切點：前一段的最後一個字，以及兩段之間被 trim 掉的東西 */
function cutsOf(segments: string[], text: string): { before: string; gap: string }[] {
  const cuts: { before: string; gap: string }[] = [];
  let pos = text.indexOf(segments[0]);
  for (let i = 0; i < segments.length - 1; i++) {
    const end = pos + segments[i].length;
    const next = text.indexOf(segments[i + 1], end);
    cuts.push({ before: segments[i][segments[i].length - 1], gap: text.slice(end, next) });
    pos = next;
  }
  return cuts;
}

/** 內容一個字都沒少（空白只可能在段落頭尾被修掉） */
function sameContent(segments: string[], original: string): boolean {
  return segments.join("").replace(/\s/g, "") === original.replace(/\s/g, "");
}

/** 可重現的亂數（mulberry32），property test 失敗時才重跑得出同一組 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("TTS_MAX_CHARS 與 route 的上限一致", () => {
  it("🔴 跟 app/api/tts/route.ts 的 MAX_TEXT_CHARS 是同一個數字（抄了一份，改一邊這裡就紅）", () => {
    const source = readFileSync(resolve(__dirname, "../../app/api/tts/route.ts"), "utf8");
    const match = source.match(/const MAX_TEXT_CHARS = (\d+);/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(TTS_MAX_CHARS);
  });

  it("每段的目標長度不超過上限", () => {
    expect(SPEECH_SEGMENT_CHARS).toBeLessThanOrEqual(TTS_MAX_CHARS);
  });
});

describe("splitForSpeech", () => {
  it("短答案原封不動一段（只去頭尾空白）——正常答案只打一次 /api/tts", () => {
    expect(splitForSpeech("  婦女新知是 1982 年 2 月創刊的。\n")).toEqual([
      "婦女新知是 1982 年 2 月創刊的。",
    ]);
  });

  it("空字串與純空白回 []，不要送一段空的去換 400", () => {
    expect(splitForSpeech("")).toEqual([]);
    expect(splitForSpeech(" \n\t ")).toEqual([]);
  });

  it("🔴 單句長度剛好等於上限：不可以再被逗點之類的切點多切一刀（off-by-one）", () => {
    const max = 20;
    // 前面墊一句短的、以句號收尾：逼進逐句迴圈，不讓外層「整段 clean.length <= max」
    // 的捷徑先把這個案例短路掉（那樣就測不到第 122 行的逐句判斷）。
    const lead = "起頭。";
    // 句子中間帶一個逗點：如果「剛好等於上限」被誤判成「超過上限」，就會被送去
    // 退到逗點切開，句子會被拆成兩塊、甚至跟前一句黏在一起。
    const exact = "壹，".padEnd(max - 1, "貳") + "。";
    expect(exact.length).toBe(max); // 前提：這一句本身剛好等於上限
    const text = lead + exact;
    expect(text.length).toBeGreaterThan(max); // 前提：整段沒有被外層捷徑短路

    // 剛好等於上限的單句要整句保留，原封不動地自成一段——不可以在逗點處被切開。
    expect(splitForSpeech(text, max)).toEqual([lead, exact]);
  });

  it("🔴 超過 600 字：每段 ≤ 600（也 ≤ 500 的目標）、切在句界、內容一字不少、段落塞滿", () => {
    // 30 句、每句 40 字（含句號）＝ 1,200 字
    const sentence = (i: number) => `第${String(i).padStart(2, "0")}句`.padEnd(39, "婦") + "。";
    const text = Array.from({ length: 30 }, (_, i) => sentence(i)).join("");
    expect(text.length).toBe(1200);

    const segments = splitForSpeech(text);

    // 500 字塞得下 12 句（480 字）→ 12＋12＋6，三段。
    // ⚠️ 不是一句一段：每多一段就多吃一格 /api/tts 限流
    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(TTS_MAX_CHARS);
      expect(segment.length).toBeLessThanOrEqual(SPEECH_SEGMENT_CHARS);
      expect(segment.endsWith("。")).toBe(true);
    }
    expect(segments.join("")).toBe(text);
  });

  it("切點帶著收尾引號走：「……。」要切在 」 後面，下一段不可以用引號開頭", () => {
    const quote = "她說：「" + "我們要爭取平等的工作權".repeat(4) + "。」";
    const filler = "這是一段夾在中間的說明文字，".repeat(3) + "到此為止。";
    const text = Array.from({ length: 12 }, () => quote + filler).join("");
    expect(text.length).toBeGreaterThan(TTS_MAX_CHARS);

    // 預設長度之外再用 60 字跑一次：那樣每一句都自成一段，切點一定會碰到每一個 。」
    for (const max of [SPEECH_SEGMENT_CHARS, 60]) {
      const segments = splitForSpeech(text, max);
      expect(segments.length).toBeGreaterThan(1);
      for (const segment of segments) {
        expect(CLOSERS.has(segment[0])).toBe(false);
        expect(segment.length).toBeLessThanOrEqual(max);
      }
      expect(sameContent(segments, text)).toBe(true);
    }
    expect(splitForSpeech(text, 60).some((segment) => segment.endsWith("。」"))).toBe(true);
  });

  it("換行、驚嘆號、問號、分號、刪節號都算句界", () => {
    const pieces = ["這樣對嗎？", "當然！", "先這樣；", "然後呢……", "換一行\n"];
    const text = Array.from({ length: 40 }, (_, i) => pieces[i % pieces.length].padStart(20, "字")).join("");
    const segments = splitForSpeech(text);
    expect(segments.length).toBeGreaterThan(1);
    // 每個切點：前一段以句末標點結尾，或者切掉的空白裡有換行（換行本身會被 trim 掉）
    for (const cut of cutsOf(segments, text)) {
      expect(cut.gap.trim()).toBe("");
      expect(ENDERS.has(cut.before) || cut.gap.includes("\n")).toBe(true);
    }
    expect(sameContent(segments, text)).toBe(true);
  });

  it("單句就超長（整段沒有句號）：退到逗號切，不硬切在字中間", () => {
    const clause = "這一段是很長的敘述而且模型沒有下句號".padEnd(45, "長") + "，";
    const text = clause.repeat(30); // 1,380 字、一個句號都沒有
    const segments = splitForSpeech(text);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(SPEECH_SEGMENT_CHARS);
    }
    for (const segment of segments.slice(0, -1)) {
      expect(segment.endsWith("，")).toBe(true);
    }
    expect(segments.join("")).toBe(text);
  });

  it("🔴 完全沒有標點只能硬切時，不可以切斷代理對（擴充區漢字、emoji）", () => {
    // 𠀀（U+20000）與 👩 都是代理對，.length 算 2。讓它們剛好橫跨各種切點。
    for (let offset = 0; offset < 4; offset++) {
      const text = "字".repeat(offset) + "𠀀👩".repeat(400); // 1,600 code unit 以上
      const segments = splitForSpeech(text);
      expect(segments.length).toBeGreaterThan(1);
      for (const segment of segments) {
        expect(segment.length).toBeLessThanOrEqual(SPEECH_SEGMENT_CHARS);
        expect(hasLoneSurrogate(segment)).toBe(false);
      }
      expect(segments.join("")).toBe(text);
    }
  });

  it("maxChars 可以調小；超過 600 會被夾回 600（route 收不下的長度不可以放行）", () => {
    const text = "一二三四五。六七八九十。".repeat(100);
    for (const segment of splitForSpeech(text, 12)) expect(segment.length).toBeLessThanOrEqual(12);
    for (const segment of splitForSpeech(text, 5000)) {
      expect(segment.length).toBeLessThanOrEqual(TTS_MAX_CHARS);
    }
  });

  it("🔴 亂數壓力測試：任何輸入，每段都 ≤ 600、沒有落單的代理對、內容一字不少", () => {
    const alphabet = [
      "婦", "女", "運", "動", "李", "元", "貞", "的", "是", "在", "a", "B", "1",
      "𠀀", "👩", "🏽", "。", "，", "！", "？", "；", "…", "、", "：", "「", "」", "『", "』",
      "（", "）", " ", "　", "\n", "\t", ".", ",", "!", "?",
    ];
    // 第三種回合完全沒有任何切點，只剩硬切——代理對最容易在這裡被拆開
    const noDelimiters = alphabet.filter((ch) => !/[。，！？；…、：\n\s,.!?:;]/.test(ch));
    const random = rng(20260929);
    for (let round = 0; round < 300; round++) {
      const length = Math.floor(random() * 3000);
      // 1/3 回合照常、1/3 刻意少放句末標點（逼出逗號退路）、1/3 完全不放
      const mode = round % 3;
      const pool = mode === 2 ? noDelimiters : alphabet;
      let text = "";
      while (text.length < length) {
        const ch = pool[Math.floor(random() * pool.length)];
        if (mode === 1 && /[。，！？；…、：\n]/.test(ch) && random() < 0.97) continue;
        text += ch;
      }
      const segments = splitForSpeech(text);
      for (const segment of segments) {
        expect(segment.length).toBeGreaterThan(0);
        expect(segment.length).toBeLessThanOrEqual(TTS_MAX_CHARS);
        expect(segment.length).toBeLessThanOrEqual(SPEECH_SEGMENT_CHARS);
        expect(hasLoneSurrogate(segment)).toBe(false);
        expect(segment).toBe(segment.trim());
      }
      expect(sameContent(segments, text)).toBe(true);
    }
  });
});

// ── sequenceSpeechStreams ──────────────────────────────────

function streamOf(chunks: Uint8Array[], hooks: { onCancel?: () => void; failAfter?: number } = {}) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (hooks.failAfter !== undefined && i === hooks.failAfter) {
        controller.error(new TypeError("network error"));
        return;
      }
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i++]);
    },
    cancel() {
      hooks.onCancel?.();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

const bytes = (...values: number[]) => new Uint8Array(values);

describe("sequenceSpeechStreams", () => {
  it("依序接成一條；下一段等上一段的串流收完才去要（限流一次只佔一格）", async () => {
    const log: string[] = [];
    const bodies = [
      streamOf([bytes(1, 2), bytes(3, 4)]),
      streamOf([bytes(5, 6)]),
      streamOf([bytes(7, 8), bytes(9, 10)]),
    ];
    const open = vi.fn(async (text: string, index: number) => {
      log.push(`open ${index} ${text}`);
      return bodies[index];
    });

    const stream = sequenceSpeechStreams(["甲", "乙", "丙"], open, () => {
      throw new Error("不該失敗");
    });
    const reader = stream.getReader();

    const first = await reader.read();
    expect(first.value).toEqual(bytes(1, 2));
    expect(open).toHaveBeenCalledTimes(1); // 第一段還沒收完，第二段不可以先送出去

    const rest: number[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest.push(...Array.from(value));
    }
    expect(rest).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(log).toEqual(["open 0 甲", "open 1 乙", "open 2 丙"]);
  });

  it("🔴 中間某一段拿不到：不丟錯、已經收到的照常交出去，回報第幾段，後面的不再要", async () => {
    const onFailure = vi.fn();
    const open = vi.fn(async (_text: string, index: number) => {
      if (index === 1) throw new Error("TTS 400");
      return streamOf([bytes(1, 2)]);
    });

    const all = await readAll(sequenceSpeechStreams(["甲", "乙", "丙"], open, onFailure));

    expect(Array.from(all)).toEqual([1, 2]);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toBe(1);
    expect(open).toHaveBeenCalledTimes(2); // 丙沒有被要
  });

  it("第一段就拿不到：整條是空的（呼叫端看得出一個取樣都沒收到）", async () => {
    const onFailure = vi.fn();
    const all = await readAll(
      sequenceSpeechStreams(["甲"], async () => Promise.reject(new Error("TTS 502")), onFailure)
    );
    expect(all.byteLength).toBe(0);
    expect(onFailure).toHaveBeenCalledWith(0, expect.any(Error));
  });

  it("讀到一半斷線：已經收到的交出去、回報失敗、不接下一段", async () => {
    const onFailure = vi.fn();
    const open = vi.fn(async (_text: string, index: number) =>
      index === 0 ? streamOf([bytes(1, 2), bytes(3, 4)], { failAfter: 1 }) : streamOf([bytes(9, 9)])
    );
    const all = await readAll(sequenceSpeechStreams(["甲", "乙"], open, onFailure));
    expect(Array.from(all)).toEqual([1, 2]);
    expect(onFailure).toHaveBeenCalledWith(0, expect.any(TypeError));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("🔴 某一段的位元組數是奇數：補一個 0，下一段的取樣才不會整個錯位", async () => {
    const open = async (_text: string, index: number) =>
      index === 0 ? streamOf([bytes(1, 2, 3)]) : streamOf([bytes(0x34, 0x12)]);
    const all = await readAll(sequenceSpeechStreams(["甲", "乙"], open, () => {}));

    expect(all.byteLength % 2).toBe(0);
    // 第二段的第一個取樣（0x1234，little-endian）必須落在偶數位移上
    const view = new DataView(all.buffer);
    expect(view.getInt16(4, true)).toBe(0x1234);
  });

  it("被 cancel（LipSyncPlayer.stop 之後）：手上那一段也 cancel，後面的不再要", async () => {
    const onCancel = vi.fn();
    const open = vi.fn(async () => streamOf([bytes(1, 2), bytes(3, 4), bytes(5, 6)], { onCancel }));

    const reader = sequenceSpeechStreams(["甲", "乙"], open, () => {}).getReader();
    await reader.read();
    await reader.cancel();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("🔴 open() 還沒回來就被 cancel：晚到的 body 要被 cancel 掉，不可以被接上變成正在讀的串流", async () => {
    let resolveOpen!: (body: ReadableStream<Uint8Array>) => void;
    const openPromise = new Promise<ReadableStream<Uint8Array>>((resolve) => {
      resolveOpen = resolve;
    });
    const open = vi.fn(async () => openPromise);

    const reader = sequenceSpeechStreams(["甲"], open, () => {
      throw new Error("不該失敗");
    }).getReader();

    const pending = reader.read(); // 促使 pull() 開跑，卡在 `await open(...)` 還沒回來
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(open).toHaveBeenCalledTimes(1); // 前提：open() 真的已經在飛、還沒 resolve

    await reader.cancel("測試中途取消"); // 在 open() 回來之前就 cancel
    expect(await pending).toEqual({ done: true, value: undefined });

    const onCancel = vi.fn();
    const body = streamOf([bytes(9, 9)], { onCancel });
    const getReaderSpy = vi.spyOn(body, "getReader");
    resolveOpen(body); // 現在 open() 才回來，body 晚到

    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(onCancel).toHaveBeenCalledTimes(1); // 晚到的 body 必須被 cancel 掉
    expect(getReaderSpy).not.toHaveBeenCalled(); // 不可以被接上變成正在讀的串流
  });
});
