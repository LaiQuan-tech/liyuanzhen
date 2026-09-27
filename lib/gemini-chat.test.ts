import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * streamChatResponse 在模型回了零個字時要把原因印出來（finishReason／blockReason），
 * 下次再出現空白泡泡才查得到是安全過濾還是別的。完全不打 API：SDK 換成吐假 chunk 的類別。
 *
 * persona-prompt 也換掉：這裡只驗串流收尾，不驗 system prompt。
 */
const fake = vi.hoisted(() => ({ chunks: [] as unknown[] }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContentStream: async () =>
        (async function* () {
          for (const c of fake.chunks) yield c;
        })(),
    };
  },
}));
vi.mock("./persona-prompt", () => ({ buildSystemPrompt: () => "（system prompt）" }));

import { streamChatResponse } from "./gemini-chat";

const QUESTION = "妳是同性戀嗎？我想知道妳怎麼看同性婚姻這件事情，還有婦女新知的立場";

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
const savedKey = process.env.GEMINI_API_KEY;
beforeEach(() => {
  process.env.GEMINI_API_KEY = "test-key"; // createClient() 只檢查有沒有值；SDK 是假的，不會送出去
  warn.mockClear();
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
