import { cookies } from "next/headers";
import type { User } from "@supabase/supabase-js";
import { createAuthServerClient, hasAuthCredentials } from "./supabase-auth";

/**
 * 後台的權限閘門。
 *
 * 🔴 **middleware 不是防線，這裡才是。**
 *
 * `middleware.ts` 只負責「沒登入就導去登入頁」，那是給人看的體驗。
 * 但 server action 與 route handler 是可以被直接呼叫的——瀏覽器 devtools
 * 裡就打得到。只靠 middleware 擋，等於在門口貼一張「請勿進入」。
 *
 * 所以**每一支會改資料的 server action 開頭都要呼叫 `requireStaff()`
 * 或 `requireManager()`**。少寫一支，那一支就是整個後台的洞。
 *
 * ── 兩層角色（0006 之後）────────────────────────────────────
 *
 *   管理員 admin   全部，含人員管理與看稽核日誌
 *   小編   editor  場次上架、報名名單、問答紀錄；不能管人、不能看日誌
 *
 * 對應到這個檔案的兩組函式：
 *
 *   isStaff()   / requireStaff()    「你在不在後台白名單裡」——不分層級
 *   isManager() / requireManager()  「這件事歸不歸你管」——只有 admin 過
 */

/**
 * 目前登入的使用者。沒登入回 null。
 *
 * 🔴 用 `getUser()` 不是 `getSession()`。
 * `getSession()` 只是把 cookie 裡的東西解出來還給你——那份 cookie 是使用者
 * 自己送上來的，內容可以偽造。`getUser()` 會拿去 Auth 伺服器驗簽章，
 * 是唯一能證明「這個人真的是他」的方法。多一次往返，換一個真的閘門。
 */
export async function currentUser(): Promise<User | null> {
  // ⚠️ 沒設 anon key 就回 null，不要讓 createAuthServerClient 丟例外。
  // 丟例外的話 /admin 會是一個 500 白畫面，看不出「只是還沒設定」——
  // 而那正是剛接手的人最可能遇到的狀態。
  if (!hasAuthCredentials()) return null;
  const store = cookies();
  const supabase = createAuthServerClient({
    getAll: () => store.getAll(),
    setAll: (list) => {
      for (const c of list) store.set(c.name, c.value, c.options);
    },
  });
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user ?? null;
}

/**
 * 這個錯誤是不是「函式不存在」。
 *
 * 🔴 只有這一種錯誤可以讓 `isStaff()` 退回舊的判斷（見下面）。
 * 42883 是 Postgres 的 undefined_function；PGRST202 是 PostgREST 在 schema
 * 快取裡找不到那支 RPC——0006 還沒跑時撞到的多半是後者。
 */
function isMissingFunction(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "42883" ||
    error.code === "PGRST202" ||
    /Could not find the function|does not exist/i.test(error.message ?? "")
  );
}

/** 用登入者自己的 session 建 client。⚠️ 不要換成 service_role，理由見 isManager()。 */
function sessionClient() {
  const store = cookies();
  return createAuthServerClient({
    getAll: () => store.getAll(),
    // 這幾支只讀不寫，session 的續期交給 middleware。
    setAll: () => {},
  });
}

/**
 * 這個使用者在不在後台白名單裡——**不分層級**。
 *
 * ⚠️ 用**使用者自己的 session** 呼叫 RPC，不要用 service_role。
 * service_role 繞過 RLS，可以查任何人的角色——那樣寫的話，「這個請求
 * 屬於誰」就完全靠上一行傳進來的字串決定，傳錯一次就是越權。
 * 用 session client 的話，身分是 Supabase 驗過的，傳不進去別人的 uuid。
 *
 * 🔴 **`has_any_role` 在 0006 跑之前不存在。**
 * 如果照一般的「查詢失敗就保守回 false」處理，部署完程式碼、SQL 還沒跑的
 * 那段空窗裡**所有人都進不了後台**——包含要進去跑那份 SQL 的那個人。
 * 所以這裡多一條退路：**只在「函式不存在」時**退回 `has_role(uid,'admin')`，
 * 也就是 0006 之前唯一存在的判斷。
 *
 * ⚠️ 這條退路**只在「函式不存在」時成立**。其他錯誤（連線失敗、權限被撤、
 * 逾時）一律回 false。把那些也退成「放行」就是提權：資料庫掛掉時最不該
 * 發生的事，就是後台自動開門。
 */
export async function isStaff(): Promise<boolean> {
  if (!hasAuthCredentials()) return false;
  const supabase = sessionClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return false;

  const { data, error } = await supabase.rpc("has_any_role", { _user_id: user.id });
  if (!error) return Boolean(data);

  if (!isMissingFunction(error)) {
    console.error("[admin-auth] has_any_role 查詢失敗，保守拒絕：", error.message);
    return false;
  }

  // 降級這一段要留 log：它代表 0006 還沒跑，而在那之前小編一個都加不進來。
  console.error(
    "[admin-auth] has_any_role 還不存在——請跑 supabase/migrations/0006_admin_users_and_audit.sql。" +
      "在那之前只有 admin 進得了後台。"
  );
  const fallback = await supabase.rpc("has_role", { _user_id: user.id, _role: "admin" });
  if (fallback.error) {
    console.error("[admin-auth] has_role 查詢也失敗，保守拒絕：", fallback.error.message);
    return false;
  }
  return Boolean(fallback.data);
}

/**
 * 這個使用者是不是**管理員**（相對於小編）。
 *
 * ⚠️ 用**使用者自己的 session** 呼叫 `has_role`，不要用 service_role。
 * service_role 繞過 RLS，可以查任何人的角色——那樣寫的話，「這個請求
 * 屬於誰」就完全靠上一行傳進來的字串決定，傳錯一次就是越權。
 * 用 session client 的話，身分是 Supabase 驗過的，傳不進去別人的 uuid。
 */
export async function isManager(): Promise<boolean> {
  if (!hasAuthCredentials()) return false;
  const supabase = sessionClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return false;

  const { data, error } = await supabase.rpc("has_role", {
    _user_id: user.id,
    _role: "admin",
  });
  if (error) {
    // 查不到就當作沒有權限。⚠️ 不要 fallback 成「放行」——
    // 資料庫掛掉時最不該發生的事就是後台自動開門。
    console.error("[admin-auth] has_role 查詢失敗，保守拒絕：", error.message);
    return false;
  }
  return Boolean(data);
}

/**
 * 舊名。0006 之前「管理員」與「進得了後台」是同一件事，所以這支等於 isManager()。
 * 留著是為了不讓還沒改完的呼叫端靜默改變語意——新的程式碼請用
 * `isStaff()`（在不在白名單）或 `isManager()`（是不是管理員）。
 */
export async function isAdmin(): Promise<boolean> {
  return isManager();
}

/**
 * 「你不該進後台」。
 *
 * ⚠️ 跟 NotManagerError 是兩件事，訊息的正確下一步不同：
 * 這一個的下一步是「請管理員把你加進後台人員」，那一個是「這件事請管理員做」。
 */
export class NotStaffError extends Error {
  constructor() {
    super("此帳號沒有後台權限，請管理員把它加進「後台人員」");
    this.name = "NotStaffError";
  }
}

/**
 * 「你可以用後台，但這件事不歸你」。
 *
 * ⚠️ 小編撞到的是這一個。不要跟 NotStaffError 合併——對小編說「你沒有後台
 * 權限」是錯的，他明明就在後台裡，只是這一頁不歸他管。
 */
export class NotManagerError extends Error {
  constructor() {
    super("這個動作只有管理員做得到");
    this.name = "NotManagerError";
  }
}

/** 給登入者看的錯誤：他登入了，只是沒有權限。跟「沒登入」要分開。 */
export class NotAdminError extends Error {
  constructor() {
    super("此帳號沒有管理權限");
    this.name = "NotAdminError";
  }
}

/**
 * 每一支會改資料的 server action 的第一行。
 *
 * ⚠️ 回傳值不是重點，「有沒有丟例外」才是。不要寫成
 * `const ok = await requireStaff()` 然後忘記判斷。
 * （回傳 User 是為了接著寫稽核日誌——`writeAudit(actor, …)` 要它。）
 */
export async function requireStaff(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new NotStaffError();
  if (!(await isStaff())) throw new NotStaffError();
  return user;
}

/** 人員管理與稽核日誌專用。小編過不了這一關。 */
export async function requireManager(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new NotManagerError();
  if (!(await isManager())) throw new NotManagerError();
  return user;
}

/**
 * 舊名，等於 requireManager()——只是丟的是 NotAdminError。
 *
 * ⚠️ 回傳值不是重點，「有沒有丟例外」才是。不要寫成
 * `const ok = await requireAdmin()` 然後忘記判斷。
 */
export async function requireAdmin(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new NotAdminError();
  if (!(await isAdmin())) throw new NotAdminError();
  return user;
}
