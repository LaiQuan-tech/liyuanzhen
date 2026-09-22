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
