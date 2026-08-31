import { describe, it, expect } from "vitest";
import {
  classifyInteraction,
  parseFilter,
  parsePage,
  totalPages,
  channelLabel,
  shortSession,
  formatTimestamp,
  formatSimilarity,
  PAGE_SIZE,
} from "./types";

describe("classifyInteraction", () => {
  it("正常回答", () => {
    expect(classifyInteraction({ in_scope: true, blocked: false, failed: false })).toBe("ok");
  });

  it("離題婉拒", () => {
    expect(classifyInteraction({ in_scope: false, blocked: false, failed: false })).toBe(
      "out-of-scope"
    );
  });

  it("護欄攔下", () => {
    expect(classifyInteraction({ in_scope: true, blocked: true, failed: false })).toBe("blocked");
  });

  it("生成失敗", () => {
    expect(classifyInteraction({ in_scope: true, blocked: false, failed: true })).toBe("failed");
  });

  // 🔴 這一條是整個分類存在的理由。
  // 檢索失敗會同時寫下 failed=true 與 in_scope=false，
  // 照 in_scope 判就會顯示成「離題婉拒」——把系統故障讀成訪客問偏了。
  it("檢索失敗（failed 與 in_scope=false 同時成立）要判成系統出錯，不是離題", () => {
    expect(classifyInteraction({ in_scope: false, blocked: false, failed: true })).toBe("failed");
  });

  it("failed 的優先序高於 blocked", () => {
    expect(classifyInteraction({ in_scope: true, blocked: true, failed: true })).toBe("failed");
  });
});

describe("parseFilter", () => {
  it("認得的值原樣回傳", () => {
    expect(parseFilter("unanswered")).toBe("unanswered");
    expect(parseFilter("failed")).toBe("failed");
    expect(parseFilter("all")).toBe("all");
  });

  it("認不得的一律回 all，不要丟例外", () => {
    expect(parseFilter(undefined)).toBe("all");
    expect(parseFilter(null)).toBe("all");
    expect(parseFilter("")).toBe("all");
    expect(parseFilter("'; drop table interactions; --")).toBe("all");
  });
});

describe("parsePage", () => {
  it("正常頁碼", () => {
    expect(parsePage("1")).toBe(1);
    expect(parsePage("7")).toBe(7);
  });

  // 後台不該因為有人亂改網址就 500
  it("髒值一律回第 1 頁", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage(null)).toBe(1);
    expect(parsePage("")).toBe(1);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-3")).toBe(1);
    expect(parsePage("1.5")).toBe(1);
    expect(parsePage("abc")).toBe(1);
    expect(parsePage("Infinity")).toBe(1);
  });
});

describe("totalPages", () => {
  it("沒有資料時仍然是 1 頁，不是 0 頁", () => {
    expect(totalPages(0)).toBe(1);
  });

  it("不滿一頁算一頁", () => {
    expect(totalPages(1)).toBe(1);
    expect(totalPages(PAGE_SIZE - 1)).toBe(1);
  });

  it("剛好整除不多算一頁", () => {
    expect(totalPages(PAGE_SIZE)).toBe(1);
    expect(totalPages(PAGE_SIZE * 2)).toBe(2);
  });

  it("多一筆就多一頁", () => {
    expect(totalPages(PAGE_SIZE + 1)).toBe(2);
  });

  // 正式站 2026-08-31 實測 144 筆
  it("144 筆是 2 頁", () => {
    expect(totalPages(144)).toBe(2);
  });
});

describe("channelLabel", () => {
  it("認得的介面", () => {
    expect(channelLabel("chat")).toBe("文字");
    expect(channelLabel("live")).toBe("語音");
  });

  // 0005 之前的資料沒有 channel，那是資料的年紀不是錯誤
  it("舊資料顯示成破折號", () => {
    expect(channelLabel(null)).toBe("—");
  });
});

describe("shortSession", () => {
  it("只取前 8 碼", () => {
    expect(shortSession("763537ac-08ab-4cdb-99d6-246a52db46ad")).toBe("763537ac");
  });

  it("比 8 短的原樣回傳", () => {
    expect(shortSession("abc")).toBe("abc");
  });
});

describe("formatTimestamp", () => {
  it("砍到分鐘並把 T 換成空白", () => {
    expect(formatTimestamp("2026-08-31T14:57:23.215071+00:00")).toBe("2026-08-31 14:57");
  });
});

describe("formatSimilarity", () => {
  it("轉成百分比", () => {
    expect(formatSimilarity(0.62)).toBe("62%");
    expect(formatSimilarity(1)).toBe("100%");
    expect(formatSimilarity(0)).toBe("0%");
  });

  it("null 顯示破折號", () => {
    expect(formatSimilarity(null)).toBe("—");
  });
});
