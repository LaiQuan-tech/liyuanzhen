import { describe, it, expect } from "vitest";
import { chunkMarkdown, parseFrontMatter } from "./chunk-text";

const META = { source: "test", sourceUrl: "https://example.com", docTitle: "測試文件" };

describe("parseFrontMatter", () => {
  it("解析 front-matter 並回傳剩餘內文", () => {
    const { meta, body } = parseFrontMatter(
      "---\nsource: 維基百科\nsourceUrl: https://zh.wikipedia.org/x\ntitle: 生平\n---\n內文開始"
    );
    expect(meta.source).toBe("維基百科");
    expect(meta.sourceUrl).toBe("https://zh.wikipedia.org/x");
    expect(meta.docTitle).toBe("生平");
    expect(body.trim()).toBe("內文開始");
  });

  it("沒有 front-matter 時原樣回傳", () => {
    const { meta, body } = parseFrontMatter("直接就是內文");
    expect(meta).toEqual({});
    expect(body).toBe("直接就是內文");
  });
});

describe("chunkMarkdown", () => {
  it("每塊的 embedInput 都要掛上標題麵包屑", () => {
    const chunks = chunkMarkdown("## 創辦經過\n\n一段內容。", META);
    expect(chunks[0].embedInput).toContain("【測試文件 · 創辦經過】");
    expect(chunks[0].content).toBe("一段內容。");
    expect(chunks[0].title).toBe("測試文件 · 創辦經過");
  });

  it("超過 maxChars 會切開，且相鄰塊要有重疊", () => {
    const para = (n: number) => `第${n}段：${"字".repeat(60)}`;
    const md = `## 節\n\n${para(1)}\n\n${para(2)}\n\n${para(3)}\n\n${para(4)}`;
    const chunks = chunkMarkdown(md, META, { maxChars: 140, overlapParagraphs: 1 });

    expect(chunks.length).toBeGreaterThan(1);
    // 重疊：後一塊的開頭應該包含前一塊的最後一段
    const prevLast = chunks[0].content.split("\n\n").pop()!;
    expect(chunks[1].content).toContain(prevLast);
  });

  it("overlapParagraphs 設 0 就不重疊", () => {
    const para = (n: number) => `第${n}段：${"字".repeat(60)}`;
    const md = `## 節\n\n${para(1)}\n\n${para(2)}\n\n${para(3)}`;
    const chunks = chunkMarkdown(md, META, { maxChars: 140, overlapParagraphs: 0 });
    const prevLast = chunks[0].content.split("\n\n").pop()!;
    expect(chunks[1].content).not.toContain(prevLast);
  });

  it("front-matter 的 source/sourceUrl 會覆蓋 fallback", () => {
    const chunks = chunkMarkdown(
      "---\nsource: 婦女新知\nsourceUrl: https://awakening.org.tw\n---\n## 節\n\n內容",
      META
    );
    expect(chunks[0].source).toBe("婦女新知");
    expect(chunks[0].sourceUrl).toBe("https://awakening.org.tw");
  });

  it("不同標題的內容不會被混進同一塊", () => {
    const chunks = chunkMarkdown("## A\n\n甲內容\n\n## B\n\n乙內容", META);
    const a = chunks.find((c) => c.title.includes("A"));
    const b = chunks.find((c) => c.title.includes("B"));
    expect(a?.content).toBe("甲內容");
    expect(b?.content).toBe("乙內容");
  });
});
