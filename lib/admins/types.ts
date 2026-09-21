/**
 * 後台人員的型別與驗證。
 *
 * ⚠️ 這個檔案**不碰資料庫**，全是純函式，所以測得到。
 * 照 `lib/events/types.ts` 的既有紀律：會出錯的判斷抽成純函式，
 * 讓它可以被釘死在測試裡。
 */

/** 管理員＝全部；小編＝場次上架、報名名單、問答紀錄。 */
export type AdminRole = "admin" | "editor";

/** 下拉選單的順序。權限大的在上面，跟一般人的心智模型一致。 */
export const ADMIN_ROLES: readonly AdminRole[] = ["admin", "editor"];

export const ROLE_LABEL: Record<AdminRole, string> = {
  admin: "管理員",
  editor: "小編",
};

export const ROLE_HINT: Record<AdminRole, string> = {
  admin: "全部功能，含人員管理與操作日誌",
  editor: "場次上架、報名名單、問答紀錄；不能管人、看不到日誌",
};

/** 表單／網址來的字串轉成角色。認不得回 null，由呼叫端決定要怎麼講。 */
export function parseRole(raw: string | undefined | null): AdminRole | null {
  return raw === "admin" || raw === "editor" ? raw : null;
}

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_RULE_HINT = "至少 8 碼，而且要同時有英文字母與數字";

/**
 * 密碼規則。
 *
 * ⚠️ **應用層是這條規則唯一的防線。**
 * Supabase 專案的密碼原則很可能還是預設值（最短 6 碼、不要求字元類別），
 * 所以 GoTrue 不會幫忙擋——從 Dashboard 手動改密碼那條路根本繞得過去。
 * 也就是說：這裡放寬一格，整個後台的密碼下限就跟著降一格。
 *
 * 🔴 **不 trim。** 前後的空白是密碼的一部分。
 * 在這裡 trim 的後果是：使用者設的跟他以為的不一樣（他打了 " abc1234"，
 * 存進去卻是 "abc1234"），而他下次登入時會照自己記得的那組打，然後失敗。
 *
 * ⚠️ 回傳**全部**的問題而不是第一個。一次只講一個錯，使用者要來回試三次
 * 才知道規則長什麼樣。
 */
export function passwordProblems(password: string): string[] {
  const errors: string[] = [];
  if (password === "") {
    errors.push("請設定密碼");
    return errors;
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`密碼至少要 ${PASSWORD_MIN_LENGTH} 碼`);
  }
  if (!/[A-Za-z]/.test(password)) errors.push("密碼要包含英文字母");
  if (!/[0-9]/.test(password)) errors.push("密碼要包含數字");
  return errors;
}

export interface NewAdminInput {
  email: string;
  password: string;
  role: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

/**
 * 驗證「新增後台人員」表單。
 *
 * ⚠️ 回傳**所有錯誤**而不是第一個——信箱打錯又密碼太短的時候，
 * 一次只講一個會讓人來回送出兩次才知道全部的問題。
 */
export function validateNewAdmin(input: NewAdminInput): ValidationResult {
  const errors: string[] = [];

  // ⚠️ email 可以 trim（前後空白不是信箱的一部分，而且使用者多半是貼上來的）。
  // 密碼不行——理由見 passwordProblems()。
  const email = input.email.trim();
  if (!email) {
    errors.push("請填電子信箱");
  } else if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    // 刻意用很寬鬆的規則。email 的正確性最後是靠「登得進來」決定的，
    // 在這裡用嚴格的正規表達式只會擋掉合法但少見的信箱。
    errors.push("電子信箱格式不正確");
  }

  errors.push(...passwordProblems(input.password));

  if (!parseRole(input.role)) errors.push("請選擇層級");

  return errors.length ? { ok: false, errors } : { ok: true };
}

/** 人員列表的一列。user_roles 與 GoTrue 的帳號資料合起來之後的樣子。 */
export interface AdminRow {
  user_id: string;
  /** GoTrue 那邊查不到時是 null——理論上不會發生（外鍵是 cascade），但別當成保證。 */
  email: string | null;
  role: AdminRole;
  /** 加進 user_roles 的時間，不是帳號建立時間。 */
  created_at: string;
  /** 從來沒登入過是 null。用來看「密碼給出去了對方到底有沒有用」。 */
  last_sign_in_at: string | null;
}

/**
 * 後台表單的回傳狀態。
 *
 * ⚠️ 定義在這裡而不是 actions.ts：`"use server"` 的檔案只能 export
 * async function。型別會被編譯期抹掉所以其實放得進去，但常數放不進去，
 * 兩種東西分開放才不會有人照著前例把常數也加進那個檔案。
 * （那個錯誤只有 `npm run build` 會現形，tsc --noEmit 不會擋。）
 */
export interface AdminActionState {
  /** 一次回傳全部的錯誤，不是第一個。 */
  errors: string[];
  /** 成功時給人看的話。⚠️ 絕不要把密碼放進來。 */
  message?: string;
}

export const IDLE_STATE: AdminActionState = { errors: [] };
