import { describe, it, expect } from "vitest";
import { expandQuery, type HistoryTurn } from "./query-expansion";

const history: HistoryTurn[] = [
  { role: "user", text: "婦女新知基金會是怎麼開始的？" },
  { role: "model", text: "（前一輪的回答）" },
];

describe("expandQuery", () => {
  it("完整的獨立問題不動它", () => {
    const q = "李元貞老師是哪一年開始投身婦女運動的？";
    expect(expandQuery(q, history)).toBe(q);
  });

  it("「那後來呢？」要接上前一則使用者訊息", () => {
    const out = expandQuery("那後來呢？", history);
    expect(out).toContain("婦女新知基金會是怎麼開始的？");
    expect(out).toContain("那後來呢？");
  });

  it("極短的問題也要補脈絡", () => {
    expect(expandQuery("為什麼？", history)).toContain("婦女新知基金會");
  });

  it("沒有歷史時原樣回傳，不能爆掉", () => {
    expect(expandQuery("那後來呢？", [])).toBe("那後來呢？");
  });

  it("只會拿使用者訊息當錨，不會拿 AI 的回答", () => {
    const onlyModel: HistoryTurn[] = [{ role: "model", text: "這是一段夠長的模型回答內容" }];
    expect(expandQuery("那後來呢？", onlyModel)).toBe("那後來呢？");
  });

  it("空字串安全", () => {
    expect(expandQuery("   ", history)).toBe("");
  });
});
