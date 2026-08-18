import { describe, it, expect } from "vitest";
import { sanitizeTranscript, MAX_TRANSCRIPT_CHARS } from "./index";

describe("sanitizeTranscript", () => {
  it("乾淨的逐字稿原封不動", () => {
    expect(sanitizeTranscript("婦女新知是怎麼開始的？")).toBe("婦女新知是怎麼開始的？");
  });

  it("去掉前後空白", () => {
    expect(sanitizeTranscript("  民法親屬編為什麼要修？  ")).toBe("民法親屬編為什麼要修？");
  });

  it("去掉模型自己加的前綴", () => {
    expect(sanitizeTranscript("逐字稿：華西街那場遊行")).toBe("華西街那場遊行");
    expect(sanitizeTranscript("轉錄結果: 眾女成城")).toBe("眾女成城");
    expect(sanitizeTranscript("以下是逐字稿：性平會")).toBe("性平會");
  });

  it("去掉整段包起來的引號", () => {
    expect(sanitizeTranscript("「婦運是什麼」")).toBe("婦運是什麼");
    expect(sanitizeTranscript('"婦運是什麼"')).toBe("婦運是什麼");
    expect(sanitizeTranscript("『婦運是什麼』")).toBe("婦運是什麼");
  });

  it("句子中間的引號要留著——那是說話內容的一部分", () => {
    expect(sanitizeTranscript("她說「我不同意」然後就走了")).toBe("她說「我不同意」然後就走了");
  });

  it("換行壓成空白：逐字稿裡的換行沒有意義", () => {
    expect(sanitizeTranscript("婦女新知\n是怎麼\n開始的")).toBe("婦女新知 是怎麼 開始的");
  });

  it("多餘空白壓成一個", () => {
    expect(sanitizeTranscript("婦女    新知")).toBe("婦女 新知");
  });

  it("⚠️ Markdown 符號要清掉——會被朗讀出來，也會干擾 embedding", () => {
    expect(sanitizeTranscript("**婦女新知**是什麼")).toBe("婦女新知是什麼");
    expect(sanitizeTranscript("# 標題 `code`")).toBe("標題 code");
  });

  it("⚠️ 沒聽到人聲的各種講法一律變成空字串", () => {
    // 留著的話會被當成訪客真的問了「（無法辨識）」，送進 RAG 然後她認真回答一個沒人問的問題
    for (const value of [
      "（無法辨識）",
      "(無聲)",
      "[空白]",
      "【沒有人說話】",
      "無法辨識",
      "N/A",
      "silence",
      "（靜音）",
    ]) {
      expect(sanitizeTranscript(value), value).toBe("");
    }
  });

  it("空輸入、只有空白、null 都回空字串", () => {
    expect(sanitizeTranscript("")).toBe("");
    expect(sanitizeTranscript("   ")).toBe("");
    expect(sanitizeTranscript("\n\n")).toBe("");
    expect(sanitizeTranscript(undefined as unknown as string)).toBe("");
  });

  it("超長逐字稿截到上限", () => {
    const long = "婦".repeat(MAX_TRANSCRIPT_CHARS + 100);
    expect(sanitizeTranscript(long)).toHaveLength(MAX_TRANSCRIPT_CHARS);
  });

  it("含「無」字的正常問題不可以被誤判成沒人說話", () => {
    // NON_SPEECH 那條 regex 必須是整段比對，不是包含比對
    expect(sanitizeTranscript("婦運有沒有遇到反對的聲音")).toBe("婦運有沒有遇到反對的聲音");
    expect(sanitizeTranscript("那時候有沒有人支持")).toBe("那時候有沒有人支持");
  });

  it("前綴與引號同時出現也要清乾淨", () => {
    expect(sanitizeTranscript("逐字稿：「婦女新知是怎麼開始的？」")).toBe(
      "婦女新知是怎麼開始的？"
    );
  });
});
