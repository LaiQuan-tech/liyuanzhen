import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * streamChatResponse 在模型回了零個字時要把原因印出來（finishReason／blockReason），
 * 下次再出現空白泡泡才查得到是安全過濾還是別的。完全不打 API：SDK 換成吐假 chunk 的類別。
 *
 * persona-prompt 也換掉：這裡只驗串流收尾，不驗 system prompt。
 */
const fake = vi.hoisted(() => ({
  chunks: [] as unknown[],
  /** 最後一次 generateContentStream 收到的參數（看 config.abortSignal 用） */
  lastParams: null as null | { config?: { abortSignal?: AbortSignal } },
  /** 設了就改用它產生串流（逾時測試：吐一段之後卡住，直到 abortSignal 觸發才丟例外） */
  impl: null as null | ((params: { config?: { abortSignal?: AbortSignal } }) => Promise<AsyncGenerator<unknown>>),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContentStream: async (params: { config?: { abortSignal?: AbortSignal } }) => {
        fake.lastParams = params;
        if (fake.impl) return fake.impl(params);
        return (async function* () {
          for (const c of fake.chunks) yield c;
        })();
      },
    };
  },
}));
vi.mock("./persona-prompt", () => ({ buildSystemPrompt: () => "（system prompt）" }));

import { GENERATION_TIMEOUT_MS, streamChatResponse } from "./gemini-chat";

const QUESTION = "妳是同性戀嗎？我想知道妳怎麼看同性婚姻這件事情，還有婦女新知的立場";

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
const savedKey = process.env.GEMINI_API_KEY;
beforeEach(() => {
  process.env.GEMINI_API_KEY = "test-key"; // createClient() 只檢查有沒有值；SDK 是假的，不會送出去
  warn.mockClear();
  fake.impl = null;
  fake.lastParams = null;
});
afterAll(() => {
  warn.mockRestore();
  if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedKey;
});

describe("streamChatResponse：空白答案", () => {
  it("零個字時印出 finishReason 與問題字數，回傳值照舊是空字串", async () => {
    fake.chunks = [{ text: undefined, candidates: [{ finishReason: "SAFETY" }] }];
    const deltas: string[] = [];
    const text = await streamChatResponse(QUESTION, [], [], (d) => deltas.push(d));
    expect(text).toBe("");
    expect(deltas).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[chat] 模型回了空白答案", {
      finishReason: "SAFETY",
      blockReason: null,
      questionChars: Array.from(QUESTION).length,
    });
  });

  /**
   * 🔴 log 會留在 Vercel，訪客的問題一個字都不能進去。原本印前 20 字，
   * 短問題（「妳是同性戀嗎」）就整句進了 log。
   */
  it("問題的內容不會出現在 log 裡（短問題也一樣）", async () => {
    fake.chunks = [{ text: undefined, candidates: [{ finishReason: "SAFETY" }] }];
    await streamChatResponse("妳是同性戀嗎", [], [], () => {});
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("同性戀");
    expect(logged).toContain('"questionChars":6');
  });

  it("blockReason 只在第一個 chunk 出現也記得住", async () => {
    fake.chunks = [
      { text: undefined, promptFeedback: { blockReason: "PROHIBITED_CONTENT" } },
      { text: undefined, candidates: [{ finishReason: "OTHER" }] },
    ];
    await streamChatResponse(QUESTION, [], [], () => {});
    expect(warn).toHaveBeenCalledWith(
      "[chat] 模型回了空白答案",
      expect.objectContaining({ finishReason: "OTHER", blockReason: "PROHIBITED_CONTENT" })
    );
  });

  it("只有空白也算零個字", async () => {
    fake.chunks = [{ text: "\n " }, { text: undefined, candidates: [{ finishReason: "STOP" }] }];
    const text = await streamChatResponse(QUESTION, [], [], () => {});
    expect(text).toBe("\n ");
    expect(warn).toHaveBeenCalledWith(
      "[chat] 模型回了空白答案",
      expect.objectContaining({ finishReason: "STOP" })
    );
  });

  it("輸出被截斷（MAX_TOKENS）時丟例外，交給 route 的生成失敗分支", async () => {
    fake.chunks = [
      { text: "婚姻能提供愛與親密感，它對我就" },
      { text: undefined, candidates: [{ finishReason: "MAX_TOKENS" }] },
    ];
    await expect(streamChatResponse(QUESTION, [], [], () => {})).rejects.toThrow("MAX_TOKENS");
    expect(warn).toHaveBeenCalledWith(
      "[chat] 模型輸出被截斷（MAX_TOKENS）",
      expect.objectContaining({ questionChars: expect.any(Number) })
    );
  });

  it("有字的回答不印警告，逐段交給 onTextDelta", async () => {
    fake.chunks = [
      { text: "我在 1982 年" },
      { text: "辦了《婦女新知》。", candidates: [{ finishReason: "STOP" }] },
    ];
    const deltas: string[] = [];
    const text = await streamChatResponse(QUESTION, [], [], (d) => deltas.push(d));
    expect(text).toBe("我在 1982 年辦了《婦女新知》。");
    expect(deltas).toEqual(["我在 1982 年", "辦了《婦女新知》。"]);
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 第十五輪（獨立審查）：原本只接 MAX_TOKENS。SAFETY、RECITATION、OTHER 這些原因半途停下、已經吐了字時，
 * 半截照常回傳，被當成正常回答送出去、存進紀錄（審查探針：7 種原因裡 6 種）。
 */
describe("streamChatResponse：非 STOP 的結束原因", () => {
  it.each(["SAFETY", "RECITATION", "OTHER", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "LANGUAGE"])(
    "有字＋finishReason=%s → 丟例外（交給 route 的生成失敗分支），log 只記原因與字數",
    async (reason) => {
      fake.chunks = [{ text: "婚姻能提供愛與親密感，它對我就" }, { text: undefined, candidates: [{ finishReason: reason }] }];
      await expect(streamChatResponse("妳怎麼看婚姻", [], [], () => {})).rejects.toThrow(reason);
      expect(warn).toHaveBeenCalledWith("[chat] 模型輸出異常結束", {
        finishReason: reason,
        chars: Array.from("婚姻能提供愛與親密感，它對我就").length,
        questionChars: 6,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("婚姻");
    }
  );

  it("空白＋SAFETY 照舊回空字串（route 換 UNGROUNDED_REPLY 並記 failed）", async () => {
    fake.chunks = [{ text: undefined, candidates: [{ finishReason: "SAFETY" }] }];
    await expect(streamChatResponse(QUESTION, [], [], () => {})).resolves.toBe("");
  });

  it("finishReason 沒給的不動（照常回傳）", async () => {
    fake.chunks = [{ text: "我在 1982 年辦了《婦女新知》。" }];
    await expect(streamChatResponse(QUESTION, [], [], () => {})).resolves.toBe("我在 1982 年辦了《婦女新知》。");
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 第十五輪（獨立審查）：生成逾時。route 的 maxDuration 是 30 秒，超過會被平台直接中止（訪客看到連線錯誤、後台沒有紀錄）。
 * 24 秒到就用 config.abortSignal 中止、丟例外，交給 route 的生成失敗分支（FALLBACK_REPLY、記 failed）。
 */
describe("streamChatResponse：生成逾時", () => {
  /** 吐一段字之後卡住，直到 abortSignal 觸發才丟 AbortError（跟 SDK 底下的 fetch 一樣） */
  function 卡住的串流(先吐: string[]) {
    return async (params: { config?: { abortSignal?: AbortSignal } }) =>
      (async function* () {
        for (const t of 先吐) yield { text: t };
        await new Promise<void>((_, reject) => {
          const signal = params.config?.abortSignal;
          signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
        });
      })();
  }

  it("逾時秒數是 24 秒（留時間給檢索與寫紀錄，route 的 maxDuration 是 30 秒）", () => {
    expect(GENERATION_TIMEOUT_MS).toBe(24_000);
  });

  it("串流卡住超過 24 秒 → 中止並丟例外；log 只記秒數與字數，不記問題內容", async () => {
    vi.useFakeTimers();
    try {
      fake.impl = 卡住的串流(["婚姻能提供愛與親密感，"]);
      const deltas: string[] = [];
      const p = streamChatResponse("妳是同性戀嗎", [], [], (d) => deltas.push(d));
      const settled = expect(p).rejects.toThrow("TIMEOUT");
      await vi.advanceTimersByTimeAsync(GENERATION_TIMEOUT_MS - 1);
      expect(fake.lastParams?.config?.abortSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(fake.lastParams?.config?.abortSignal?.aborted).toBe(true);
      expect(deltas).toEqual(["婚姻能提供愛與親密感，"]);
      expect(warn).toHaveBeenCalledWith("[chat] 生成逾時，已中止", {
        seconds: 24,
        chars: Array.from("婚姻能提供愛與親密感，").length,
        questionChars: 6,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("同性戀");
    } finally {
      vi.useRealTimers();
    }
  });

  it("請求本身卡住（還沒吐任何字、還在思考）也一樣中止", async () => {
    vi.useFakeTimers();
    try {
      fake.impl = (params) =>
        new Promise((_, reject) => {
          params.config?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      const p = streamChatResponse(QUESTION, [], [], () => {});
      const settled = expect(p).rejects.toThrow("TIMEOUT");
      await vi.advanceTimersByTimeAsync(GENERATION_TIMEOUT_MS);
      await settled;
      expect(warn).toHaveBeenCalledWith("[chat] 生成逾時，已中止", expect.objectContaining({ seconds: 24, chars: 0 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("正常答完的回答：計時器會清掉，不會事後中止", async () => {
    vi.useFakeTimers();
    try {
      fake.chunks = [{ text: "我在 1982 年辦了《婦女新知》。", candidates: [{ finishReason: "STOP" }] }];
      await expect(streamChatResponse(QUESTION, [], [], () => {})).resolves.toBe("我在 1982 年辦了《婦女新知》。");
      expect(vi.getTimerCount()).toBe(0);
      expect(fake.lastParams?.config?.abortSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("SDK 中止後安靜結束（沒丟例外）也當逾時，不把半截當成回答", async () => {
    vi.useFakeTimers();
    try {
      fake.impl = async (params) =>
        (async function* () {
          yield { text: "婚姻能提供" };
          await new Promise<void>((resolve) => params.config?.abortSignal?.addEventListener("abort", () => resolve()));
        })();
      const p = streamChatResponse(QUESTION, [], [], () => {});
      const settled = expect(p).rejects.toThrow("TIMEOUT");
      await vi.advanceTimersByTimeAsync(GENERATION_TIMEOUT_MS);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});
