import { describe, it, expect } from "vitest";
import {
  validateEvent,
  validateRegistration,
  acceptsRegistration,
  formatEventDate,
  formatEventTime,
  MAX_PARTY_SIZE,
  type EventInput,
  type RegistrationInput,
} from "./types";

const baseEvent = (over: Partial<EventInput> = {}): EventInput => ({
  title: "《我來了！臺灣婦女改變了》新書發表會",
  slug: "book-launch-2026",
  subtitle: "",
  description: "",
  event_date: "2026-09-20",
  start_time: "14:00",
  end_time: "16:00",
  venue: "",
  address: "",
  registration_note: "",
  status: "draft",
  ...over,
});

const baseSignup = (over: Partial<RegistrationInput> = {}): RegistrationInput => ({
  name: "王小明",
  email: "ming@example.com",
  phone: "0912345678",
  party_size: 1,
  note: "",
  consent: true,
  ...over,
});

describe("validateEvent", () => {
  it("正常的一場活動", () => {
    expect(validateEvent(baseEvent()).ok).toBe(true);
  });

  it("🔴 網址代稱不可以有中文或空白——它會直接出現在網址裡", () => {
    expect(validateEvent(baseEvent({ slug: "新書發表會" })).errors).toContain(
      "網址代稱只能用小寫英文、數字與連字號"
    );
    expect(validateEvent(baseEvent({ slug: "book launch" })).ok).toBe(false);
    expect(validateEvent(baseEvent({ slug: "Book-Launch" })).ok).toBe(false);
    expect(validateEvent(baseEvent({ slug: "../admin" })).ok).toBe(false);
  });

  it("結束時間不能早於開始時間", () => {
    const r = validateEvent(baseEvent({ start_time: "16:00", end_time: "14:00" }));
    expect(r.errors).toContain("結束時間不能早於開始時間");
  });

  it("時間是選填的，兩個都空白也算合法", () => {
    expect(validateEvent(baseEvent({ start_time: "", end_time: "" })).ok).toBe(true);
  });

  it("狀態只收那三種，別的一律擋掉", () => {
    expect(validateEvent(baseEvent({ status: "published" })).ok).toBe(true);
    expect(validateEvent(baseEvent({ status: "closed" })).ok).toBe(true);
    expect(validateEvent(baseEvent({ status: "live" })).ok).toBe(false);
  });

  it("⚠️ 一次回報所有錯誤，不是只回第一個", () => {
    // 只講一個錯的話，使用者要來回存好幾次才知道全部的問題
    const r = validateEvent(baseEvent({ title: "", slug: "", event_date: "" }));
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("validateRegistration", () => {
  it("正常報名", () => {
    expect(validateRegistration(baseSignup()).ok).toBe(true);
  });

  it("🔴 沒有勾同意就不可以收——那是蒐集個資的前提", () => {
    const r = validateRegistration(baseSignup({ consent: false }));
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("同意");
  });

  it("電話是選填的", () => {
    expect(validateRegistration(baseSignup({ phone: "" })).ok).toBe(true);
  });

  it("人數要在範圍內", () => {
    expect(validateRegistration(baseSignup({ party_size: 0 })).ok).toBe(false);
    expect(validateRegistration(baseSignup({ party_size: MAX_PARTY_SIZE })).ok).toBe(true);
    expect(validateRegistration(baseSignup({ party_size: MAX_PARTY_SIZE + 1 })).ok).toBe(false);
    expect(validateRegistration(baseSignup({ party_size: 1.5 })).ok).toBe(false);
  });

  it("信箱只做寬鬆檢查——嚴格的正規表達式會擋掉合法但少見的信箱", () => {
    expect(validateRegistration(baseSignup({ email: "a+b@sub.example.co.uk" })).ok).toBe(true);
    expect(validateRegistration(baseSignup({ email: "不是信箱" })).ok).toBe(false);
  });

  it("超長欄位要擋——輸入來自公開網際網路", () => {
    expect(validateRegistration(baseSignup({ name: "字".repeat(101) })).ok).toBe(false);
    expect(validateRegistration(baseSignup({ note: "字".repeat(1001) })).ok).toBe(false);
  });
});

describe("acceptsRegistration", () => {
  it("只有 published 收報名", () => {
    expect(acceptsRegistration("published")).toBe(true);
    expect(acceptsRegistration("draft")).toBe(false);
    // ⚠️ closed 的活動看得到但不能報名。收了等於讓人白跑一趟。
    expect(acceptsRegistration("closed")).toBe(false);
  });
});

describe("日期時間格式", () => {
  it("⚠️ 不經過 Date 物件——活動日期是牆上日曆的那一天，不是時間點", () => {
    // new Date("2026-09-20") 會被當成 UTC 午夜，在負時區會顯示成前一天
    expect(formatEventDate("2026-09-20")).toBe("2026 年 9 月 20 日");
    expect(formatEventDate("2026-01-05")).toBe("2026 年 1 月 5 日");
  });

  it("格式不對就原樣回傳，不要丟例外", () => {
    expect(formatEventDate("待定")).toBe("待定");
  });

  it("資料庫的 time 會帶秒，畫面上不需要", () => {
    expect(formatEventTime("14:00:00", "16:00:00")).toBe("14:00–16:00");
    expect(formatEventTime("14:00:00", null)).toBe("14:00");
    expect(formatEventTime(null, null)).toBe("");
  });
});
