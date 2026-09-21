import { describe, it, expect } from "vitest";
import {
  validateNewAdmin,
  passwordProblems,
  parseRole,
  ROLE_LABEL,
  ADMIN_ROLES,
  PASSWORD_MIN_LENGTH,
} from "./types";

const ok = (password: string) =>
  validateNewAdmin({ email: "someone@example.com", password, role: "admin" });

describe("密碼規則", () => {
  it("剛好 8 碼、英數字混合就過", () => {
    expect(ok("abcd1234")).toEqual({ ok: true });
  });

  it("7 碼不過", () => {
    const result = ok("abc1234");
    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, errors: [`密碼至少要 ${PASSWORD_MIN_LENGTH} 碼`] });
  });

  it("純字母不過，而且要講出缺的是數字", () => {
    expect(ok("abcdefgh")).toEqual({ ok: false, errors: ["密碼要包含數字"] });
  });

  it("純數字不過，而且要講出缺的是字母", () => {
    expect(ok("12345678")).toEqual({ ok: false, errors: ["密碼要包含英文字母"] });
  });

  it("空密碼只講一句「請設定密碼」，不要再追加三條規則", () => {
    expect(ok("")).toEqual({ ok: false, errors: ["請設定密碼"] });
  });

  /**
   * 🔴 前後空白是密碼的一部分，不可以 trim。
   *
   * " abc1234" 有 8 個字元，通過；trim 之後只剩 7 碼會失敗——
   * 所以這一條同時證明了「沒有 trim」與「長度是照原字串算的」。
   * 真正的後果不在這條測試裡：trim 過的密碼會讓使用者照自己打的那組
   * 登入時失敗，而他永遠不會想到是前面那個空白被吃掉了。
   */
  it("前後空白被保留（trim 的話這組會變成 7 碼而失敗）", () => {
    expect(ok(" abc1234")).toEqual({ ok: true });
    expect(ok("abc1234 ")).toEqual({ ok: true });
  });

  it("全是空白也算有長度，但缺字母與數字", () => {
    expect(passwordProblems("        ")).toEqual(["密碼要包含英文字母", "密碼要包含數字"]);
  });
});

describe("validateNewAdmin 的信箱", () => {
  it("正常信箱過", () => {
    expect(ok("abcd1234")).toEqual({ ok: true });
  });

  it("空信箱、沒有 @、沒有網域都不過", () => {
    for (const email of ["", "   ", "abc", "abc@", "abc@def", "a b@c.co"]) {
      const result = validateNewAdmin({ email, password: "abcd1234", role: "admin" });
      expect(result.ok, `${JSON.stringify(email)} 應該不過`).toBe(false);
    }
  });

  it("信箱前後的空白會被 trim（跟密碼相反）", () => {
    expect(
      validateNewAdmin({ email: "  someone@example.com  ", password: "abcd1234", role: "admin" })
    ).toEqual({ ok: true });
  });
});

describe("validateNewAdmin 一次回全部的錯", () => {
  /**
   * 🔴 這一條是「回傳全部錯誤」這個設計存在的理由。
   *
   * 如果實作寫成遇到第一個問題就 return，這裡只會拿到 1 個——
   * 使用者就要來回送出兩次才知道信箱跟密碼都有問題。
   */
  it("信箱壞 ＋ 密碼壞 → 2 個錯誤，不是 1 個", () => {
    const result = validateNewAdmin({
      email: "not-an-email",
      // 8 碼、有字母、沒有數字 → 剛好只產生一條密碼錯誤
      password: "abcdefgh",
      role: "admin",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors).toHaveLength(2);
    expect(result.errors).toEqual(["電子信箱格式不正確", "密碼要包含數字"]);
  });

  it("三樣全壞 → 4 個錯誤（密碼短 ＋ 缺數字 各算一條）", () => {
    const result = validateNewAdmin({ email: "", password: "abc", role: "" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.errors).toEqual([
      "請填電子信箱",
      `密碼至少要 ${PASSWORD_MIN_LENGTH} 碼`,
      "密碼要包含數字",
      "請選擇層級",
    ]);
  });
});

describe("parseRole", () => {
  it("認得的值原樣回傳", () => {
    expect(parseRole("admin")).toBe("admin");
    expect(parseRole("editor")).toBe("editor");
  });

  // 這個值會被寫進 user_roles.role（一個 enum），照單全收就是讓網址決定資料庫的內容
  it("認不得的一律 null", () => {
    expect(parseRole(undefined)).toBe(null);
    expect(parseRole(null)).toBe(null);
    expect(parseRole("")).toBe(null);
    expect(parseRole("Admin")).toBe(null);
    expect(parseRole("superuser")).toBe(null);
    expect(parseRole("'; drop table user_roles; --")).toBe(null);
  });
});

describe("ROLE_LABEL", () => {
  it("每個角色都有中文", () => {
    expect(Object.keys(ROLE_LABEL).sort()).toEqual([...ADMIN_ROLES].sort());
    expect(ROLE_LABEL.admin).toBe("管理員");
    expect(ROLE_LABEL.editor).toBe("小編");
  });
});
