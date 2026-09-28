import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryTurn } from "../query-expansion";
import type { KnowledgeChunk } from "./types";

/**
 * 假的 embedding 與向量庫：embedText 把查詢字串編成 code point 陣列，
 * store 端再解回字串查表。這樣「哪一句被拿去 embedding」「查了幾次」都能精確斷言，
 * 而且完全不碰 Gemini、Supabase 與 data/knowledge-index.json。
 */
const fake = vi.hoisted(() => {
  const table = new Map<string, KnowledgeChunk[]>();
  const embedText = vi.fn(async (text: string) =>
    Array.from(text).map((c) => c.codePointAt(0) as number)
  );
  const search = vi.fn(async (embedding: number[], k: number) => {
    const query = String.fromCodePoint(...embedding);
    return (table.get(query) ?? []).slice(0, k);
  });
  return { table, embedText, search };
});

vi.mock("../embeddings", () => ({ embedText: fake.embedText }));
vi.mock("./local", () => ({ localStore: { name: "local", search: fake.search } }));

import { HARD_FLOOR, SOFT_FLOOR, retrieve } from "./index";

function chunk(title: string, similarity: number, content = ""): KnowledgeChunk {
  return { id: `${title}#${similarity}`, source: "test", sourceUrl: "", title, content, similarity };
}

const ANCHOR = "書中聶湖濱如何述說李元貞";
const history: HistoryTurn[] = [
  { role: "user", text: ANCHOR },
  { role: "model", text: "（回答）" },
];

beforeEach(() => {
  process.env.RETRIEVAL_PROVIDER = "local";
  fake.table.clear();
  fake.embedText.mockClear();
  fake.search.mockClear();
});

describe("retrieve：主查詢／備援", () => {
  it("完整問題：原句在範圍內 → 只 embedding 一次，擴展句碰都不碰", async () => {
    const q = "你怎麼看待婚姻";
    fake.table.set(q, [chunk("第 3 章 進出婚姻 · 體驗婚姻制度", 0.742)]);
    fake.table.set(`${ANCHOR} ${q}`, [chunk("第 2 章 花蓮—鍾情之所 · 【他人敘述．聶湖濱】", 0.74)]);

    const r = await retrieve(q, history);

    expect(fake.embedText).toHaveBeenCalledTimes(1);
    expect(fake.embedText).toHaveBeenCalledWith(q, "RETRIEVAL_QUERY");
    expect(r.query).toBe(q);
    expect(r.expanded).toBe(false);
    expect(r.inScope).toBe(true);
    expect(r.chunks[0]?.title).toContain("第 3 章");
  });

  it("追問：擴展句在範圍內 → 採用擴展句，expanded=true，只 embedding 一次", async () => {
    const real: HistoryTurn[] = [
      { role: "user", text: "你有幾個兄弟姊妹？" },
      { role: "model", text: "（回答）" },
    ];
    const q = "你確定沒寫？？";
    const expanded = `你有幾個兄弟姊妹？ ${q}`;
    fake.table.set(expanded, [chunk("第 8 章 我的原生家庭 · 兄弟姊妹", 0.71)]);
    fake.table.set(q, [chunk("關於這個網站與 AI · 它會答錯嗎", 0.67)]);

    const r = await retrieve(q, real);

    expect(fake.embedText).toHaveBeenCalledTimes(1);
    expect(fake.embedText).toHaveBeenCalledWith(expanded, "RETRIEVAL_QUERY");
    expect(r.query).toBe(expanded);
    expect(r.expanded).toBe(true);
    expect(r.inScope).toBe(true);
    expect(r.chunks[0]?.title).toContain("第 8 章");
  });

  it("追問：擴展句低於門檻、原句在範圍內 → 退回原句，expanded=false，共兩次 embedding", async () => {
    const q = "那後來呢？";
    const expanded = `${ANCHOR} ${q}`;
    fake.table.set(expanded, [chunk("陪榜", HARD_FLOOR - 0.05)]);
    fake.table.set(q, [chunk("第 5 章 擎起婦運火炬 · 華西街遊行", HARD_FLOOR + 0.05)]);

    const r = await retrieve(q, history);

    expect(fake.embedText).toHaveBeenCalledTimes(2);
    expect(fake.embedText.mock.calls.map((c) => c[0])).toEqual([expanded, q]);
    expect(r.query).toBe(q);
    expect(r.expanded).toBe(false);
    expect(r.inScope).toBe(true);
    expect(r.topSimilarity).toBeCloseTo(HARD_FLOOR + 0.05);
  });

  it("完整問題：原句低於門檻、擴展句在範圍內 → 採用擴展句，expanded=true", async () => {
    const q = "你今年幾歲？";
    const expanded = `${ANCHOR} ${q}`;
    fake.table.set(q, [chunk("陪榜", HARD_FLOOR - 0.01)]);
    fake.table.set(expanded, [chunk("李元貞年表 · 2021 （75 歲）", HARD_FLOOR + 0.02)]);

    const r = await retrieve(q, history);

    expect(fake.embedText).toHaveBeenCalledTimes(2);
    expect(fake.embedText.mock.calls.map((c) => c[0])).toEqual([q, expanded]);
    expect(r.query).toBe(expanded);
    expect(r.expanded).toBe(true);
    expect(r.inScope).toBe(true);
    expect(r.chunks[0]?.title).toContain("年表");
  });

  it("兩者都低於門檻 → inScope=false、chunks 空、topSimilarity 與 query 都是主查詢的", async () => {
    const q = "台積電股價多少？";
    const expanded = `${ANCHOR} ${q}`;
    fake.table.set(q, [chunk("陪榜", 0.41)]);
    fake.table.set(expanded, [chunk("陪榜", 0.55)]); // 比主查詢高但仍低於門檻，不採用

    const r = await retrieve(q, history);

    expect(fake.embedText).toHaveBeenCalledTimes(2);
    expect(r.inScope).toBe(false);
    expect(r.chunks).toEqual([]);
    expect(r.lowConfidence).toBe(true);
    expect(r.topSimilarity).toBeCloseTo(0.41);
    expect(r.query).toBe(q);
    expect(r.expanded).toBe(false);
  });

  it("沒有錨點就沒有備援：原句低於門檻也只 embedding 一次", async () => {
    const q = "台積電股價多少？";
    fake.table.set(q, [chunk("陪榜", 0.41)]);

    const r = await retrieve(q, []);

    expect(fake.embedText).toHaveBeenCalledTimes(1);
    expect(r.inScope).toBe(false);
    expect(r.query).toBe(q);
    expect(r.expanded).toBe(false);
  });

  it("歷史裡只有追問、找不到錨點 → 追問也用原句、只 embedding 一次", async () => {
    const onlyFollowUps: HistoryTurn[] = [
      { role: "user", text: "然後呢" },
      { role: "model", text: "（回答）" },
    ];
    const q = "那後來呢？";
    fake.table.set(q, [chunk("第 5 章 擎起婦運火炬", 0.7)]);

    const r = await retrieve(q, onlyFollowUps);

    expect(fake.embedText).toHaveBeenCalledTimes(1);
    expect(r.query).toBe(q);
    expect(r.expanded).toBe(false);
    expect(r.inScope).toBe(true);
  });

  it("查不到任何候選（空表）→ inScope=false，不會爆掉", async () => {
    const r = await retrieve("李元貞是誰？", []);
    expect(r.inScope).toBe(false);
    expect(r.topSimilarity).toBe(0);
    expect(r.chunks).toEqual([]);
  });
});

describe("retrieve：門檻與切片邏輯不變", () => {
  it("top ≥ SOFT_FLOOR：只留與最佳結果差距在 0.12 內的塊、最多 5 塊、lowConfidence=false", async () => {
    const q = "李元貞是誰？";
    fake.table.set(q, [
      chunk("a", 0.9),
      chunk("b", 0.85),
      chunk("c", 0.82),
      chunk("d", 0.8),
      chunk("e", 0.79),
      chunk("f", 0.785), // 第 6 塊，被 MAX_CHUNKS 切掉
      chunk("g", 0.7), // 低於 0.9 - 0.12，被相對窗切掉
      chunk("h", 0.65),
    ]);

    const r = await retrieve(q, []);

    expect(r.inScope).toBe(true);
    expect(r.lowConfidence).toBe(false);
    expect(r.chunks.map((c) => c.title)).toEqual(["a", "b", "c", "d", "e"]);
    expect(r.provider).toBe("local");
  });

  it("HARD_FLOOR ≤ top < SOFT_FLOOR：cutoff 是 HARD_FLOOR、lowConfidence=true", async () => {
    const q = "李元貞是誰？";
    fake.table.set(q, [
      chunk("a", SOFT_FLOOR - 0.01),
      chunk("b", HARD_FLOOR),
      chunk("c", HARD_FLOOR - 0.001),
    ]);

    const r = await retrieve(q, []);

    expect(r.inScope).toBe(true);
    expect(r.lowConfidence).toBe(true);
    expect(r.chunks.map((c) => c.title)).toEqual(["a", "b"]);
  });
});

describe("retrieve：口語清理只影響 embedding 字串", () => {
  it("V-07：embedding 用清過的「妳是哪裡人」、只查一次；query 回報實際拿去 embedding 的字串", async () => {
    const q = "妳剛剛講太快了 我聽不清楚 妳再講一次妳是哪裡人";
    fake.table.set("妳是哪裡人", [
      chunk("李元貞的生平 · 出生與童年：李元貞是哪裡人？", 0.657, "她出生在雲南省景東縣"),
    ]);

    const r = await retrieve(q, []);

    expect(fake.embedText).toHaveBeenCalledTimes(1);
    expect(fake.embedText).toHaveBeenCalledWith("妳是哪裡人", "RETRIEVAL_QUERY");
    expect(r.query).toBe("妳是哪裡人");
    expect(r.expanded).toBe(false);
    expect(r.inScope).toBe(true);
    expect(r.chunks[0]?.content).toContain("景東");
  });

  it("口語的追問：追問判斷看原句（句尾「呢」），擴展句連錨點一起清", async () => {
    const spoken: HistoryTurn[] = [
      { role: "user", text: "老師妳好 請問一下妳是哪裡人" },
      { role: "model", text: "（回答）" },
    ];
    const cleaned = "妳是哪裡人 那後來呢？";
    fake.table.set(cleaned, [chunk("第 1 章 眷村歲月—鐵絲網圈住的童年", 0.7)]);

    const r = await retrieve("嗯 那後來呢？", spoken);

    expect(fake.embedText).toHaveBeenCalledTimes(1);
    expect(fake.embedText).toHaveBeenCalledWith(cleaned, "RETRIEVAL_QUERY");
    expect(r.query).toBe(cleaned);
    expect(r.expanded).toBe(true);
  });

  it("追問判斷看清過的句子：「嗯 妳確定？」是追問，主查詢接上前一題（不再只拿「妳確定？」去撈〈它會答錯嗎〉）", async () => {
    const h: HistoryTurn[] = [
      { role: "user", text: "妳有幾個兄弟姊妹？" },
      { role: "model", text: "（回答）" },
    ];
    const expectedQuery = "妳有幾個兄弟姊妹？ 妳確定？";
    fake.table.set(expectedQuery, [chunk("第 8 章 我的原生家庭 · 兄弟姊妹", 0.701)]);
    fake.table.set("妳確定？", [chunk("關於這個網站與 AI · 它會答錯嗎", 0.66)]);

    const r = await retrieve("嗯 妳確定？", h);

    expect(fake.embedText).toHaveBeenCalledTimes(1);
    expect(fake.embedText).toHaveBeenCalledWith(expectedQuery, "RETRIEVAL_QUERY");
    expect(r.query).toBe(expectedQuery);
    expect(r.expanded).toBe(true);
    expect(r.chunks[0]?.title).toContain("第 8 章");
  });

  it("追問判斷看清過的句子：「老師，請問一下，那後來呢？」（原句 12 字）是追問，接上前一題、稱呼與逗號都清掉", async () => {
    const h: HistoryTurn[] = [
      { role: "user", text: "婦女新知是哪一年成立的？" },
      { role: "model", text: "（回答）" },
    ];
    const expectedQuery = "婦女新知是哪一年成立的？ 那後來呢？";
    fake.table.set(expectedQuery, [chunk("婦女新知的創辦 · 改組為基金會", 0.78)]);

    const r = await retrieve("老師，請問一下，那後來呢？", h);

    expect(fake.embedText).toHaveBeenCalledTimes(1);
    expect(fake.embedText).toHaveBeenCalledWith(expectedQuery, "RETRIEVAL_QUERY");
    expect(r.query).toBe(expectedQuery);
    expect(r.expanded).toBe(true);
  });

  it("備援也用清過的字串：清過的主查詢低於門檻、清過的擴展句在範圍內 → 採用備援", async () => {
    const q = "老師妳好 你今年幾歲？"; // 完整問題（needsContext=false）→ 主查詢是原句
    const cleanedExpanded = `${ANCHOR} 你今年幾歲？`;
    fake.table.set("你今年幾歲？", [chunk("陪榜", HARD_FLOOR - 0.01)]);
    fake.table.set(cleanedExpanded, [chunk("李元貞的生平 · 李元貞今年幾歲？", HARD_FLOOR + 0.03)]);

    const r = await retrieve(q, history);

    expect(fake.embedText.mock.calls.map((c) => c[0])).toEqual(["你今年幾歲？", cleanedExpanded]);
    expect(r.query).toBe(cleanedExpanded);
    expect(r.expanded).toBe(true);
    expect(r.inScope).toBe(true);
  });

  it("錨點整句都是包裝（「老師妳好」）：備援清完跟主查詢一字不差 → 不重查，只 embedding 一次", async () => {
    const h: HistoryTurn[] = [
      { role: "user", text: "老師妳好" },
      { role: "model", text: "（回答）" },
    ];
    const q = "你怎麼看待婚姻";
    fake.table.set(q, [chunk("陪榜", HARD_FLOOR - 0.05)]);

    const r = await retrieve(q, h);

    expect(fake.embedText).toHaveBeenCalledTimes(1);
    expect(r.inScope).toBe(false);
    expect(r.query).toBe(q);
  });

  it("清完太短就用原句：「再說一遍」沒有錨點時 embedding 原句", async () => {
    fake.table.set("再說一遍", [chunk("陪榜", 0.5)]);

    const r = await retrieve("再說一遍", []);

    expect(fake.embedText).toHaveBeenCalledWith("再說一遍", "RETRIEVAL_QUERY");
    expect(r.query).toBe("再說一遍");
  });

  it("「再說一遍」接得到錨點：擴展句清掉重講要求後只剩上一題，正好把上一題再查一次", async () => {
    fake.table.set(ANCHOR, [chunk("第 2 章 花蓮—鍾情之所 · 【他人敘述．聶湖濱】", 0.767)]);

    const r = await retrieve("再說一遍", history);

    expect(fake.embedText).toHaveBeenCalledTimes(1);
    expect(fake.embedText).toHaveBeenCalledWith(ANCHOR, "RETRIEVAL_QUERY");
    expect(r.query).toBe(ANCHOR);
    expect(r.expanded).toBe(true);
  });
});

describe("retrieve：質疑／更正句接上一題", () => {
  it("Q-06「明明是2005年出的 妳搞錯了吧」→ 主查詢是「上一題＋質疑句」，撈回原本答案的出處", async () => {
    const h: HistoryTurn[] = [
      { role: "user", text: "妳寫的眾女成城是哪一年出版的" },
      { role: "model", text: "我的《眾女成城：台灣婦運回憶錄》，是在 2014 年 9 月出版的。" },
    ];
    const q = "明明是2005年出的 妳搞錯了吧";
    const expandedQ = `妳寫的眾女成城是哪一年出版的 ${q}`;
    fake.table.set(expandedQ, [chunk("李元貞的著作 · 眾女成城：台灣婦運回憶錄", 0.72)]);
    fake.table.set(q, [chunk("關於這個網站與 AI · 它會答錯嗎", 0.648)]);

    const r = await retrieve(q, h);

    expect(fake.embedText).toHaveBeenCalledTimes(1);
    expect(fake.embedText).toHaveBeenCalledWith(expandedQ, "RETRIEVAL_QUERY");
    expect(r.expanded).toBe(true);
    expect(r.chunks[0]?.title).toContain("眾女成城");
  });
});
