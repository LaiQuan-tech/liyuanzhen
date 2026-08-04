import { describe, it, expect } from "vitest";
import { cosineSimilarity, l2Normalize } from "./vector-math";

describe("cosineSimilarity", () => {
  it("相同方向為 1", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("正交為 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("相反方向為 -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("必須對長度不敏感——這正是它跟裸內積的差別", () => {
    // 若誤用內積，下面兩個會得到 1 和 5，門檻就會跟 Supabase 端不一致
    expect(cosineSimilarity([1, 0], [5, 0])).toBeCloseTo(1);
  });

  it("零向量不會產生 NaN", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("維度不符要丟錯，而不是靜靜算出垃圾", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow();
  });
});

describe("l2Normalize", () => {
  it("正規化後長度為 1", () => {
    const v = l2Normalize([3, 4]);
    expect(Math.hypot(...v)).toBeCloseTo(1);
    expect(v[0]).toBeCloseTo(0.6);
  });

  it("零向量原樣回傳", () => {
    expect(l2Normalize([0, 0])).toEqual([0, 0]);
  });
});
