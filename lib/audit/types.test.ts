import { describe, it, expect } from "vitest";
import {
  ACTION_LABEL,
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  ENTITY_LABEL,
  parseEntityFilter,
  parsePage,
  totalPages,
  actorLabel,
  targetLabel,
  actionLabel,
  entityLabel,
  formatAuditTime,
  PAGE_SIZE,
} from "./types";

describe("AuditAction 與 SQL 的 CHECK", () => {
  /**
   * 🔴 這一條在防 TS 的 union 與 0006 的 CHECK constraint 分岔。
   *
   * 分岔的症狀特別難查：CHECK 擋下的那一筆寫入會被 writeAudit 吞掉
   * （它刻意不往上丟，見 index.ts），所以畫面上一切正常，只是日誌少了一種動作。
   *
   * ⚠️ 這條測的是「union ↔ 執行期陣列 ↔ 中文對照」三者一致。
   * 它**測不到** SQL 那一邊——那份檔案不在這個專案的執行路徑上。
   * 所以 0006 的 CHECK 清單旁邊也寫了一樣的提醒，兩邊互相指。
   */
  it("ACTION_LABEL 的 key 集合等於 AuditAction 的所有值", () => {
    expect(Object.keys(ACTION_LABEL).sort()).toEqual([...AUDIT_ACTIONS].sort());
  });

  it("清單就是 0006 CHECK 裡那五個值", () => {
    expect([...AUDIT_ACTIONS].sort()).toEqual(
      ["delete", "insert", "password", "revoke", "update"].sort()
    );
  });

  // revoke 與 delete 分開是後台把兩顆按鈕分開的全部理由，不能合併
  it("revoke 與 delete 是兩個不同的動作", () => {
    expect(ACTION_LABEL.revoke).not.toBe(ACTION_LABEL.delete);
  });

  it("ENTITY_LABEL 的 key 集合等於 AuditEntity 的所有值", () => {
    expect(Object.keys(ENTITY_LABEL).sort()).toEqual([...AUDIT_ENTITIES].sort());
  });
});

describe("parseEntityFilter", () => {
  it("認得的值原樣回傳", () => {
    expect(parseEntityFilter("event")).toBe("event");
    expect(parseEntityFilter("admin")).toBe("admin");
    expect(parseEntityFilter("all")).toBe("all");
  });

  it("認不得的一律回 all，不要丟例外", () => {
    expect(parseEntityFilter(undefined)).toBe("all");
    expect(parseEntityFilter(null)).toBe("all");
    expect(parseEntityFilter("")).toBe("all");
    expect(parseEntityFilter("events")).toBe("all");
    expect(parseEntityFilter("EVENT")).toBe("all");
  });

  // 這個值會被接進查詢條件。照單全收＝把網址列開放成查詢語言。
  it("注入字串退回無篩選", () => {
    expect(parseEntityFilter("'; drop table")).toBe("all");
    expect(parseEntityFilter("'; drop table admin_audit_log; --")).toBe("all");
  });
});

describe("parsePage", () => {
  it("正常頁碼原樣回傳", () => {
    expect(parsePage("1")).toBe(1);
    expect(parsePage("7")).toBe(7);
  });

  it("髒值一律當第 1 頁", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage(null)).toBe(1);
    expect(parsePage("")).toBe(1);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-3")).toBe(1);
    expect(parsePage("1.5")).toBe(1);
    expect(parsePage("abc")).toBe(1);
  });
});

describe("totalPages", () => {
  it("沒有資料也要算成 1 頁", () => {
    expect(totalPages(0)).toBe(1);
  });

  it("剛好整除不多出一頁", () => {
    expect(totalPages(PAGE_SIZE)).toBe(1);
    expect(totalPages(PAGE_SIZE * 2)).toBe(2);
  });

  it("多出一筆就多一頁", () => {
    expect(totalPages(PAGE_SIZE + 1)).toBe(2);
  });
});

describe("顯示用的退路", () => {
  it("操作者帳號已刪時講明白", () => {
    expect(actorLabel({ actor_email: "a@b.co" })).toBe("a@b.co");
    expect(actorLabel({ actor_email: null })).toBe("（帳號已刪除）");
  });

  it("label 沒有就退回編號，不要顯示空白", () => {
    expect(targetLabel({ label: "新書發表會", entity_id: "abc" })).toBe("新書發表會");
    expect(targetLabel({ label: null, entity_id: "abc" })).toBe("（編號 abc）");
    expect(targetLabel({ label: null, entity_id: null })).toBe("—");
  });

  // 日誌是歷史。哪天改了動作的名字，舊紀錄也不該變成空白格。
  it("認不得的 action／entity 原樣顯示", () => {
    expect(actionLabel("insert")).toBe("新增");
    expect(actionLabel("archive")).toBe("archive");
    expect(entityLabel("event")).toBe("場次");
    expect(entityLabel("newsletter")).toBe("newsletter");
  });
});

describe("formatAuditTime", () => {
  // 🔴 台北時間，不是伺服器時間。Vercel 的函式跑在 UTC。
  it("UTC 轉成台北時間", () => {
    expect(formatAuditTime("2026-09-21T00:30:00Z")).toBe("2026/09/21 08:30");
  });

  // 跨日那一刻最容易看出時區有沒有搞錯
  it("跨日", () => {
    expect(formatAuditTime("2026-09-20T16:00:00Z")).toBe("2026/09/21 00:00");
  });

  // h23：不要出現「上午 12:30」那種寫法
  it("午夜與正午都是 24 小時制", () => {
    expect(formatAuditTime("2026-09-20T16:30:00Z")).toBe("2026/09/21 00:30");
    expect(formatAuditTime("2026-09-21T04:00:00Z")).toBe("2026/09/21 12:00");
  });

  /**
   * 🔴 zh-TW 的 ICU 資料在日期與時間之間放的是 U+2009 THIN SPACE。
   * 那個字元跟著 ICU 版本走，而且複製到 Excel 或搜尋框會比對不到——
   * 所以 formatAuditTime 會把它換成一般空白。這一條把那件事釘住。
   */
  it("分隔用的是一般空白，不是 ICU 的 thin space", () => {
    const s = formatAuditTime("2026-09-21T00:30:00Z");
    expect(s).not.toMatch(/[ -   ]/);
    expect(s.split(" ")).toHaveLength(2);
  });
});
