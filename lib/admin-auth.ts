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
 * 所以**每一支會改資料的 server action 開頭都要呼叫 `requireAdmin()`**。
 * 少寫一支，那一支就是整個後台的洞。
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
 * 這個使用者是不是管理員。
 *
 * ⚠️ 用**使用者自己的 session** 呼叫 `has_role`，不要用 service_role。
 * service_role 繞過 RLS，可以查任何人的角色——那樣寫的話，「這個請求
 * 屬於誰」就完全靠上一行傳進來的字串決定，傳錯一次就是越權。
 * 用 session client 的話，身分是 Supabase 驗過的，傳不進去別人的 uuid。
 */
export async function isAdmin(): Promise<boolean> {
  if (!hasAuthCredentials()) return false;
  const store = cookies();
  const supabase = createAuthServerClient({
    getAll: () => store.getAll(),
    setAll: () => {},
  });
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
 * `const ok = await requireAdmin()` 然後忘記判斷。
 */
export async function requireAdmin(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new NotAdminError();
  if (!(await isAdmin())) throw new NotAdminError();
  return user;
}
