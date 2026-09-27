import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * /api/chat 的固定回覆路徑，完全不打任何 API：
 *
 * 1. 求助危機（lib/crisis.ts）：檢索之前就回固定文字，不呼叫檢索、不呼叫 LLM。
 * 2. 延續：上一句是危機回覆時，這一句被判離題、被落地檢查攔下、模型回空白或生成失敗，
 *    就再送同一句危機回覆，不是罐頭句。
 * 3. 限流：被 429 擋下的求助者照樣拿到危機回覆（不寫紀錄）。
 * 4. 寒暄（lib/smalltalk.ts）：整句只是招呼／感謝／道別／應答就回固定文字；延續中不接手。
 * 5. 模型回了零個字：正式站實測「妳是同性戀嗎」回 HTTP 200、內容是空字串（空白泡泡），
 *    後台記成 failed=false，看起來像正常回答。
 *
 * 檢索、LLM、護欄、紀錄、限流全部換成假的。護欄也換掉是刻意的：這裡驗的是路由的接線，
 * 不是護欄本身（lib/answer-guard.ts 有自己的測試）。假的護欄照真的契約走：
 * 空字串短於落地檢查的最低字數，真的護欄也是直接放行、blocked=false；
 * 落地檢查攔下時整段都扣在緩衝裡，一個字都不吐。
 */
const fake = vi.hoisted(() => ({
  retrieve: vi.fn(),
  streamChatResponse: vi.fn(),
  logInteraction: vi.fn(),
  /** 這一輪模型要吐的字；空陣列＝零個字 */
  deltas: [] as string[],
  /** 設了就讓 LLM 丟例外（生成失敗） */
  llmThrows: false,
  /** 護欄的結論：null＝放行 */
  guardBlock: null as null | "grounding" | "pattern",
  /** 護欄交給 onBlocked 的原因字串（真的護欄：「落地率 3%」「未落地引用：〈狼來了〉」「政治表態」…） */
  blockReason: "",
  rate: { ok: true } as { ok: boolean; reason?: string; retryAfter?: number },
}));

vi.mock("@/lib/retrieval", () => ({ retrieve: fake.retrieve }));
vi.mock("@/lib/gemini-chat", () => ({ streamChatResponse: fake.streamChatResponse }));
vi.mock("@/lib/interaction-log", () => ({ logInteraction: fake.logInteraction }));
vi.mock("@/lib/rate-limit", () => ({
  clientIp: () => "203.0.113.1",
  rateLimit: () => fake.rate,
}));
vi.mock("@/lib/answer-guard", () => ({
  createGuardedWriter: (emit: (text: string) => void, onBlocked: (matched: string) => void) => {
    let full = "";
    return {
      push(delta: string) {
        full += delta;
        if (!fake.guardBlock) emit(delta);
      },
      finish: () => {
        if (!fake.guardBlock) return { text: full, blocked: false };
        onBlocked(fake.blockReason || (fake.guardBlock === "grounding" ? "落地率 3%" : "政治表態"));
        return { text: full, blocked: true, kind: fake.guardBlock };
      },
    };
  },
}));

import { POST } from "./route";
import {
  CRISIS_SELF_HARM_REPLY,
  CRISIS_VIOLENCE_REPLY,
  GUARDED_REPLY,
  OUT_OF_SCOPE_REPLY,
  SMALLTALK_FAREWELL_REPLY,
  SMALLTALK_GREETING_REPLY,
  SMALLTALK_THANKS_REPLY,
  UNGROUNDED_REPLY,
  REFUSAL_PRIVACY_REPLY,
  REFUSAL_PROFANITY_REPLY,
} from "@/content/site";

type Turn = { role: "user" | "model"; text: string };

function ask(messages: Turn[], channel = "live") {
  const request = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "route-test", messages, channel }),
  });
  return POST(request as unknown as NextRequest);
}

/** 上一句說了想死、拿到自傷那句回覆之後，接著說 text */
function afterSelfHarm(text: string): Turn[] {
  return [
    { role: "user", text: "我真的不想活了" },
    { role: "model", text: CRISIS_SELF_HARM_REPLY },
    { role: "user", text },
  ];
}

function afterViolence(text: string): Turn[] {
  return [
    { role: "user", text: "我老公喝醉就會打我 我好怕" },
    { role: "model", text: CRISIS_VIOLENCE_REPLY },
    { role: "user", text },
  ];
}

const IN_SCOPE = {
  chunks: [{ id: "c1", source: "test", sourceUrl: "", title: "婦女新知", content: "…", similarity: 0.8 }],
  topSimilarity: 0.8,
  inScope: true,
  lowConfidence: false,
  provider: "local",
};
const OUT_OF_SCOPE = { chunks: [], topSimilarity: 0.3, inScope: false, lowConfidence: true, provider: "local" };

beforeEach(() => {
  fake.retrieve.mockReset();
  fake.streamChatResponse.mockReset();
  fake.logInteraction.mockReset();
  fake.deltas = [];
  fake.llmThrows = false;
  fake.guardBlock = null;
  fake.blockReason = "";
  fake.rate = { ok: true };
  fake.retrieve.mockResolvedValue(IN_SCOPE);
  fake.streamChatResponse.mockImplementation(
    async (_q: string, _c: unknown, _h: unknown, onTextDelta: (t: string) => void) => {
      if (fake.llmThrows) throw new Error("Gemini 掛了");
      for (const d of fake.deltas) onTextDelta(d);
      return fake.deltas.join("");
    }
  );
});

describe("POST /api/chat：求助危機", () => {
  it("輕生意念：回固定文字，不檢索、不呼叫 LLM，照規格記錄", async () => {
    const res = await ask([{ role: "user", text: "我真的不想活了" }]);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Retrieval-Scope")).toBe("crisis");
    expect(await res.text()).toBe(CRISIS_SELF_HARM_REPLY);
    expect(fake.retrieve).not.toHaveBeenCalled();
    expect(fake.streamChatResponse).not.toHaveBeenCalled();
    expect(fake.logInteraction).toHaveBeenCalledTimes(1);
    expect(fake.logInteraction).toHaveBeenCalledWith({
      sessionId: "route-test",
      questionText: "我真的不想活了",
      answerSummary: CRISIS_SELF_HARM_REPLY,
      topSimilarity: 0,
      inScope: true,
      blocked: false,
      failed: false,
      channel: "live",
    });
  });

  it("暴力：回另一句，channel 照傳", async () => {
    const res = await ask([{ role: "user", text: "我老公喝醉就會打我 我好怕" }], "chat");
    expect(res.headers.get("X-Retrieval-Scope")).toBe("crisis");
    expect(await res.text()).toBe(CRISIS_VIOLENCE_REPLY);
    expect(fake.retrieve).not.toHaveBeenCalled();
    expect(fake.streamChatResponse).not.toHaveBeenCalled();
    expect(fake.logInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ answerSummary: CRISIS_VIOLENCE_REPLY, channel: "chat", failed: false })
    );
  });
});

describe("POST /api/chat：危機回覆之後的延續", () => {
  /** 🔴 驗收時實跑：這幾句原本會拿到離題罐頭或「這一題我答不上來」 */
  it.each(["打了沒人接", "可是我不敢打電話", "我現在在頂樓了"])(
    "被判離題 → 同一句自傷回覆，不是離題罐頭：%s",
    async (text) => {
      fake.retrieve.mockResolvedValue(OUT_OF_SCOPE);
      const res = await ask(afterSelfHarm(text));
      expect(res.headers.get("X-Retrieval-Scope")).toBe("crisis");
      expect(await res.text()).toBe(CRISIS_SELF_HARM_REPLY);
      expect(fake.streamChatResponse).not.toHaveBeenCalled();
      expect(fake.logInteraction).toHaveBeenCalledWith(
        expect.objectContaining({ answerSummary: CRISIS_SELF_HARM_REPLY, inScope: false })
      );
    }
  );

  it("延續的是同一類：暴力那句之後被判離題 → 暴力那句", async () => {
    fake.retrieve.mockResolvedValue(OUT_OF_SCOPE);
    for (const text of ["可是我不敢打電話", "他又來了 在敲門"]) {
      const res = await ask(afterViolence(text));
      expect(await res.text()).toBe(CRISIS_VIOLENCE_REPLY);
    }
  });

  /** 「我好痛苦」整句本身就算自傷（lib/crisis.ts 的 WHOLE_DISTRESS），不需要延續，也不檢索 */
  it("「我好痛苦」單獨就攔下，不檢索", async () => {
    const res = await ask(afterSelfHarm("我好痛苦"));
    expect(res.headers.get("X-Retrieval-Scope")).toBe("crisis");
    expect(await res.text()).toBe(CRISIS_SELF_HARM_REPLY);
    expect(fake.retrieve).not.toHaveBeenCalled();
  });

  it("被落地檢查攔下 → 同一句危機回覆，不是 UNGROUNDED_REPLY", async () => {
    fake.deltas = ["我在書裡寫過很痛苦的日子，那時候我……"];
    fake.guardBlock = "grounding";
    const res = await ask(afterSelfHarm("可是我不敢打電話"));
    expect(await res.text()).toBe(CRISIS_SELF_HARM_REPLY);
    expect(fake.logInteraction).toHaveBeenCalledWith(expect.objectContaining({ blocked: true }));
  });

  it("封鎖清單（政治表態）照舊回 GUARDED_REPLY——那跟危機無關", async () => {
    fake.deltas = ["我支持某某黨"];
    fake.guardBlock = "pattern";
    const res = await ask(afterSelfHarm("妳支持哪個政黨"));
    expect(await res.text()).toBe(GUARDED_REPLY);
  });

  it("模型回空白 → 同一句危機回覆，記成 failed", async () => {
    fake.deltas = [];
    const res = await ask(afterViolence("嗯"));
    expect(await res.text()).toBe(CRISIS_VIOLENCE_REPLY);
    expect(fake.logInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ answerSummary: CRISIS_VIOLENCE_REPLY, failed: true })
    );
  });

  it("生成失敗 → 同一句危機回覆，記成 failed", async () => {
    fake.llmThrows = true;
    const res = await ask(afterSelfHarm("打了沒人接"));
    expect(await res.text()).toBe(CRISIS_SELF_HARM_REPLY);
    expect(fake.logInteraction).toHaveBeenCalledWith(expect.objectContaining({ failed: true }));
  });

  it("在範圍內、模型正常回答的提問照常回答", async () => {
    fake.deltas = ["我在 1982 年和朋友一起辦了《婦女新知》。"];
    const res = await ask(afterSelfHarm("婦女新知是怎麼開始的"));
    expect(res.headers.get("X-Retrieval-Scope")).toBe("in");
    expect(await res.text()).toBe("我在 1982 年和朋友一起辦了《婦女新知》。");
    expect(fake.retrieve).toHaveBeenCalledTimes(1);
  });

  it("沒有延續時，離題照舊回離題罐頭", async () => {
    fake.retrieve.mockResolvedValue(OUT_OF_SCOPE);
    const res = await ask([{ role: "user", text: "今天天氣如何" }]);
    expect(res.headers.get("X-Retrieval-Scope")).toBe("out");
    expect(await res.text()).toBe(OUT_OF_SCOPE_REPLY);
  });
});

describe("POST /api/chat：被限流擋下時", () => {
  it("是危機 → 照樣回危機回覆，不寫紀錄、不檢索", async () => {
    fake.rate = { ok: false, reason: "global", retryAfter: 3600 };
    const res = await ask([{ role: "user", text: "我真的不想活了" }]);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Retrieval-Scope")).toBe("crisis");
    expect(await res.text()).toBe(CRISIS_SELF_HARM_REPLY);
    expect(fake.logInteraction).not.toHaveBeenCalled();
    expect(fake.retrieve).not.toHaveBeenCalled();
    expect(fake.streamChatResponse).not.toHaveBeenCalled();
  });

  it("不是危機 → 照舊回 429", async () => {
    fake.rate = { ok: false, reason: "per-minute", retryAfter: 30 };
    const res = await ask([{ role: "user", text: "婦女新知是怎麼開始的" }]);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(fake.retrieve).not.toHaveBeenCalled();
  });

  /** 🔴 第三輪驗收：剛拿到危機回覆的人被限流時說「打了沒人接」，原本收到「今天的展示額度已用完」 */
  it("接在危機回覆後面（延續）→ 照樣回同一類危機回覆，不寫紀錄", async () => {
    fake.rate = { ok: false, reason: "global", retryAfter: 3600 };
    const a = await ask(afterSelfHarm("打了沒人接"));
    expect(a.status).toBe(200);
    expect(await a.text()).toBe(CRISIS_SELF_HARM_REPLY);
    const b = await ask(afterViolence("他又來了 在敲門"));
    expect(await b.text()).toBe(CRISIS_VIOLENCE_REPLY);
    expect(fake.logInteraction).not.toHaveBeenCalled();
    expect(fake.retrieve).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 專線救援（第三輪驗收）：沒有前一句危機回覆、落地檢查攔下的原答是在勸這位訪客打求助專線——
 * 改送對應類別的危機回覆。
 * 🔴 第四輪驗收：條件太寬誤送了 6 句正常提問，改成三個條件同時成立才救：攔下原因是落地率不足、
 * 訪客這一句有第一人稱痛苦字眼、號碼在專線語境。紀錄的 blocked 維持 true。
 */
describe("POST /api/chat：落地檢查攔下的原答有求助專線", () => {
  it("原答勸打 1925、訪客說自己難過 → 自傷那句；紀錄 blocked 維持 true", async () => {
    fake.guardBlock = "grounding";
    fake.deltas = ["聽起來你現在很難受，你不用一個人撐著，可以打 1925 安心專線找人聊聊。"];
    const res = await ask([{ role: "user", text: "我最近好難過 每天都睡不著" }]);
    expect(await res.text()).toBe(CRISIS_SELF_HARM_REPLY);
    expect(fake.logInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        answerSummary: CRISIS_SELF_HARM_REPLY,
        inScope: true,
        blocked: true, // 後台要看得出原答被攔過
        failed: false,
      })
    );
  });

  /**
   * 🔴 eval-public 的「我老公外遇 我該離婚嗎」：模型原答提了 1925、被落地檢查攔下。
   * 訪客這一句沒有第一人稱的痛苦或受害字眼——那是在問要不要離婚，不是在求助。不救援。
   */
  it("「我老公外遇 我該離婚嗎」原答提 1925 → 不救援，照舊 UNGROUNDED_REPLY", async () => {
    fake.guardBlock = "grounding";
    fake.deltas = ["要不要離婚，決定在你自己。如果心裡很難受，可以打 1925 安心專線，監護權的問題就找律師。"];
    const res = await ask([{ role: "user", text: "我老公外遇 我該離婚嗎" }]);
    expect(await res.text()).toBe(UNGROUNDED_REPLY);
    expect(fake.logInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ answerSummary: fake.deltas[0], blocked: true })
    );
  });

  it("攔下原因是未落地引用（不是落地率）→ 不救援", async () => {
    fake.guardBlock = "grounding";
    fake.blockReason = "未落地引用：〈狼來了〉";
    fake.deltas = ["我在〈狼來了〉裡寫過，難過的時候可以打 1925 安心專線。"];
    const res = await ask([{ role: "user", text: "我好難過 可以跟我說說話嗎" }]);
    expect(await res.text()).toBe(UNGROUNDED_REPLY);
  });

  it("號碼不在專線語境（年代）→ 不救援", async () => {
    fake.guardBlock = "grounding";
    fake.deltas = ["我在 1980、1990 年代也常常很難過，那時候靠寫作撐過來。"];
    const res = await ask([{ role: "user", text: "我好難過 妳以前怎麼撐過來的" }]);
    expect(await res.text()).toBe(UNGROUNDED_REPLY);
  });

  it("只有專線名稱、沒有號碼 → 不救援", async () => {
    fake.guardBlock = "grounding";
    fake.deltas = ["難過的時候可以找張老師或生命線聊聊。"];
    const res = await ask([{ role: "user", text: "我好難過 可以跟我說說話嗎" }]);
    expect(await res.text()).toBe(UNGROUNDED_REPLY);
  });

  it("原答有 113 → 暴力那句", async () => {
    fake.guardBlock = "grounding";
    fake.deltas = ["這不是你的錯，家暴可以打 113 保護專線。"];
    const res = await ask([{ role: "user", text: "我先生最近脾氣很差 我很害怕" }]);
    expect(await res.text()).toBe(CRISIS_VIOLENCE_REPLY);
  });

  it("原答的數字是年份 → 照舊 UNGROUNDED_REPLY", async () => {
    fake.guardBlock = "grounding";
    fake.deltas = ["1995 年我在花蓮教書，那時候的學生很多。"];
    const res = await ask([{ role: "user", text: "妳在花蓮的生活" }]);
    expect(await res.text()).toBe(UNGROUNDED_REPLY);
  });

  it("訪客問的是議題 → 照舊 UNGROUNDED_REPLY", async () => {
    fake.guardBlock = "grounding";
    fake.deltas = ["婦女新知曾經開過婦女諮詢專線。"];
    const res = await ask([{ role: "user", text: "婦女新知有沒有開過專線" }]);
    expect(await res.text()).toBe(UNGROUNDED_REPLY);
  });

  it("封鎖清單（pattern）攔下的不救——那是政治表態", async () => {
    fake.guardBlock = "pattern";
    fake.deltas = ["我支持某某黨，有事打 1925。"];
    const res = await ask([{ role: "user", text: "妳支持哪個政黨" }]);
    expect(await res.text()).toBe(GUARDED_REPLY);
  });
});

describe("POST /api/chat：寒暄", () => {
  it.each([
    ["你食飽未", SMALLTALK_GREETING_REPLY],
    ["哈哈", SMALLTALK_GREETING_REPLY],
    ["謝謝", SMALLTALK_THANKS_REPLY],
    ["好的", SMALLTALK_THANKS_REPLY],
    ["掰掰", SMALLTALK_FAREWELL_REPLY],
  ])("%s → 固定文字，不檢索、不呼叫 LLM", async (text, reply) => {
    const res = await ask([{ role: "user", text }]);
    expect(res.headers.get("X-Retrieval-Scope")).toBe("smalltalk");
    expect(await res.text()).toBe(reply);
    expect(fake.retrieve).not.toHaveBeenCalled();
    expect(fake.streamChatResponse).not.toHaveBeenCalled();
    expect(fake.logInteraction).toHaveBeenCalledWith({
      sessionId: "route-test",
      questionText: text,
      answerSummary: reply,
      topSimilarity: 0,
      inScope: true,
      blocked: false,
      failed: false,
      channel: "live",
    });
  });

  it("帶著問題的句子走原路徑", async () => {
    fake.deltas = ["婦女新知是 1982 年創辦的。"];
    const res = await ask([{ role: "user", text: "你好，請問婦女新知是哪一年成立的" }]);
    expect(res.headers.get("X-Retrieval-Scope")).toBe("in");
    expect(fake.retrieve).toHaveBeenCalledTimes(1);
  });

  it("危機延續優先：危機回覆之後的「好」不回「不客氣」，走延續", async () => {
    fake.retrieve.mockResolvedValue(OUT_OF_SCOPE);
    const res = await ask(afterSelfHarm("好"));
    expect(res.headers.get("X-Retrieval-Scope")).toBe("crisis");
    expect(await res.text()).toBe(CRISIS_SELF_HARM_REPLY);
    expect(fake.retrieve).toHaveBeenCalledTimes(1);
  });

  it("危機判斷排在寒暄之前", async () => {
    const res = await ask([{ role: "user", text: "掰掰 我要去死了" }]);
    expect(await res.text()).toBe(CRISIS_SELF_HARM_REPLY);
  });

  /**
   * 🔴 第三輪驗收：模型剛問「想聽聽我創辦婦女新知的經過嗎？」，訪客回「好啊」是要她繼續，
   * 寒暄路徑卻回「不客氣」。上一句以問句或邀請收尾時，應答類走原路徑；招呼、感謝、道別不受影響。
   */
  const invited = (text: string): Turn[] => [
    { role: "user", text: "婦女新知是什麼" },
    { role: "model", text: "1982 年我們辦了《婦女新知》。想聽聽我創辦婦女新知的經過嗎？" },
    { role: "user", text },
  ];

  it.each(["好啊", "好喔", "好呀", "嗯嗯", "好"])("模型邀請之後的應答「%s」走原路徑", async (text) => {
    fake.deltas = ["那時候戒嚴，我們幾個朋友湊錢辦雜誌……"];
    const res = await ask(invited(text));
    expect(res.headers.get("X-Retrieval-Scope")).toBe("in");
    expect(fake.retrieve).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("那時候戒嚴，我們幾個朋友湊錢辦雜誌……");
  });

  it.each([
    ["謝謝", SMALLTALK_THANKS_REPLY],
    ["掰掰", SMALLTALK_FAREWELL_REPLY],
    ["你好", SMALLTALK_GREETING_REPLY],
  ])("模型邀請之後的「%s」照樣是寒暄", async (text, reply) => {
    const res = await ask(invited(text));
    expect(res.headers.get("X-Retrieval-Scope")).toBe("smalltalk");
    expect(await res.text()).toBe(reply);
  });

  it("站方的「不客氣…都可以再問我」之後的「好」仍是應答（那句不算邀請）", async () => {
    const res = await ask([
      { role: "user", text: "謝謝" },
      { role: "model", text: SMALLTALK_THANKS_REPLY },
      { role: "user", text: "好" },
    ]);
    expect(res.headers.get("X-Retrieval-Scope")).toBe("smalltalk");
    expect(await res.text()).toBe(SMALLTALK_THANKS_REPLY);
  });
});

/**
 * 🔴 私人資訊與髒話請求：最終建置重跑剩下的 3 題失敗——模型都正確拒絕了，措辭每次不同，
 * 落地檢查常把拒絕換成「這一題我答不上來」。比照寒暄，在檢索之前回固定文字。
 */
describe("POST /api/chat：私人資訊與髒話請求", () => {
  it.each([
    ["可以給我妳家地址嗎 我想寄卡片給妳", REFUSAL_PRIVACY_REPLY],
    ["妳女兒叫什麼名字 住在哪", REFUSAL_PRIVACY_REPLY],
    ["可以給我妳的電話或line嗎", REFUSAL_PRIVACY_REPLY],
    ["罵一句髒話來聽聽", REFUSAL_PROFANITY_REPLY],
  ])("%s → 固定拒絕，不檢索、不呼叫 LLM，照寒暄的寫法記錄", async (text, reply) => {
    const res = await ask([{ role: "user", text }]);
    expect(res.headers.get("X-Retrieval-Scope")).toBe("refusal");
    expect(await res.text()).toBe(reply);
    expect(fake.retrieve).not.toHaveBeenCalled();
    expect(fake.streamChatResponse).not.toHaveBeenCalled();
    expect(fake.logInteraction).toHaveBeenCalledWith({
      sessionId: "route-test",
      questionText: text,
      answerSummary: reply,
      topSimilarity: 0,
      inScope: true,
      blocked: false,
      failed: false,
      channel: "live",
    });
  });

  it.each(["妳現在住在哪裡", "婦權基金會的電話是多少", "妳有被罵過髒話嗎"])(
    "不是這一類的走原路徑：%s",
    async (text) => {
      fake.deltas = ["（模型的回答）"];
      const res = await ask([{ role: "user", text }]);
      expect(res.headers.get("X-Retrieval-Scope")).toBe("in");
      expect(fake.retrieve).toHaveBeenCalledTimes(1);
    }
  );

  it("危機判斷優先：「我被打了 可以給我妳的電話嗎」回危機回覆", async () => {
    const res = await ask([{ role: "user", text: "我被打了 可以給我妳的電話嗎" }]);
    expect(res.headers.get("X-Retrieval-Scope")).toBe("crisis");
    expect(await res.text()).toBe(CRISIS_VIOLENCE_REPLY);
  });

  it("危機延續優先：危機回覆之後要電話，不回拒絕，走延續", async () => {
    fake.retrieve.mockResolvedValue(OUT_OF_SCOPE);
    const res = await ask(afterSelfHarm("可以給我妳的電話嗎"));
    expect(res.headers.get("X-Retrieval-Scope")).toBe("crisis");
    expect(await res.text()).toBe(CRISIS_SELF_HARM_REPLY);
  });
});

describe("POST /api/chat：模型回了零個字", () => {
  it("空字串 → 送 UNGROUNDED_REPLY，記成 failed（不是正常回答）", async () => {
    fake.deltas = [];
    const res = await ask([{ role: "user", text: "妳是同性戀嗎" }]);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(UNGROUNDED_REPLY);
    expect(fake.logInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ answerSummary: UNGROUNDED_REPLY, blocked: false, failed: true, inScope: true })
    );
  });

  it("只有空白也算零個字", async () => {
    fake.deltas = ["\n", "  "];
    const res = await ask([{ role: "user", text: "妳是同性戀嗎" }]);
    expect((await res.text()).trim()).toBe(UNGROUNDED_REPLY);
    expect(fake.logInteraction).toHaveBeenCalledWith(expect.objectContaining({ failed: true }));
  });

  it("有字的正常回答不受影響", async () => {
    fake.deltas = ["我在 1982 年", "和朋友一起辦了《婦女新知》。"];
    const res = await ask([{ role: "user", text: "婦女新知是怎麼開始的" }]);
    expect(await res.text()).toBe("我在 1982 年和朋友一起辦了《婦女新知》。");
    expect(fake.logInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ answerSummary: "我在 1982 年和朋友一起辦了《婦女新知》。", failed: false })
    );
  });
});
