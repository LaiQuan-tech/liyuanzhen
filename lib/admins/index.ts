import { createAdminSupabase, hasSupabase } from "../supabase";
import { listAuthUsers } from "./provision";
import { parseRole } from "./types";
import type { AdminRole, AdminRow } from "./types";

export * from "./types";

/**
 * 後台人員名冊的讀寫。
 *
 * 🔴 這個檔案**只碰 `user_roles`**，完全不碰 `auth.admin.*`。
 * 帳號本身（建立、密碼、刪除）在 `./provision.ts`。兩件事分開，
 * 「建了帳號但授權失敗」時才有辦法只回滾其中一半。
 *
 * 🔴 寫入走 service_role，不走使用者自己的 session——這是刻意的，
 * 理由寫在 0006 第二節：這個站的登入 client 是 anon key ＋ 管理員 session，
 * **活在瀏覽器裡**。一旦給 authenticated 寫入權限，任何管理員在 devtools
 * 打一行 insert 就能自己升權，而且**不會留下任何稽核紀錄**（日誌是伺服器
 * 端寫的）。「所有寫入都必須經過伺服器」是這份稽核可信的前提。
 *
 * 代價：少了「server action 忘記 requireManager() 時由 DB 兜底」那一層。
 * 改用 `lib/audit/coverage.test.ts` 在測試期擋。
 *
 * 🔴 **client component 不可以 import 這個檔（含 `@/lib/admins` 這個路徑）。**
 * 它 import 了 `./provision.ts` → `lib/admin-auth.ts` → `next/headers`，
 * 在 "use client" 檔案裡會直接 build 失敗：
 *   "You're importing a component that needs next/headers."
 * 型別與常數請從 `@/lib/admins/types` 進來——那個檔不碰資料庫也不碰 next/headers。
 * ⚠️ `tsc --noEmit` 與 vitest 都不會擋這個，只有 `npm run build` 會。
 */

/** 把 Postgres 的錯誤翻成後台看得懂的話。 */
function friendly(error: { code?: string; message?: string }): Error {
  const message = error.message ?? "";

  // 🔴 0006 的 keep_one_admin trigger。raise exception 'LAST_ADMIN' 的
  // SQLSTATE 是 P0001，訊息就是那串原文。
  if (/LAST_ADMIN/i.test(message)) {
    return new Error("系統至少要留一位管理員，這是最後一位，不能移除或降級。");
  }

  // 🔴 22P02 = invalid input value for enum。0006 還沒跑的話 app_role 只有
  // 'admin'，任何跟小編有關的操作都會撞這個。錯誤原文是英文的 enum 訊息，
  // 完全看不出真正該做的事是去跑那份 SQL。
  if (error.code === "22P02") {
    return new Error(
      "「小編」這個層級還不存在。請先跑 supabase/migrations/0006_admin_users_and_audit.sql。"
    );
  }

  if (error.code === "23503") {
    return new Error("找不到這個帳號，它可能剛剛被刪除了。");
  }

  return new Error(`人員設定失敗：${message}`);
}

/** 後台專用：讓頁面能顯示「請先跑 migration」而不是 500。 */
export class MissingTableError extends Error {
  constructor() {
    super("後台人員的資料表還沒建立");
    this.name = "MissingTableError";
  }
}

/**
 * 形狀照抄 `lib/events/index.ts` 的同名函式，但**刻意各自寫一份**——
 * 那是那個模組的私有判斷，跨模組 import 會把兩邊綁在一起。
 */
function isMissingTable(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /does not exist|Could not find the table/i.test(error.message ?? "")
  );
}

interface RoleRow {
  user_id: string;
  role: string;
  created_at: string;
}

/**
 * 後台人員列表。
 *
 * ⚠️ 名冊在 `user_roles`，但 email 與最後登入時間在 GoTrue——兩邊沒辦法
 * join（auth schema 不開放給 PostgREST），所以這裡撈回來自己對。
 *
 * ⚠️ 「還在不在」的唯一依據是 `user_roles`。GoTrue 那邊有帳號但這裡沒有列的
 * 人**不會出現在這個列表上**——那正是「建了帳號但授權失敗」留下的孤兒帳號
 * 看不見的原因，所以那種情況一定要寫進稽核日誌（見 createAdminAction）。
 */
export async function listAdmins(): Promise<AdminRow[]> {
  if (!hasSupabase()) return [];

  const db = createAdminSupabase();
  const { data, error } = await db
    .from("user_roles")
    .select("user_id, role, created_at")
    .order("created_at", { ascending: true });

  if (error) {
    if (isMissingTable(error)) throw new MissingTableError();
    throw new Error(`讀取後台人員失敗：${error.message}`);
  }

  const roles = (data ?? []) as RoleRow[];
  const accounts = await listAuthUsers();
  const byId = new Map(accounts.map((a) => [a.id, a]));

  return roles.map((r) => {
    const account = byId.get(r.user_id);
    return {
      user_id: r.user_id,
      email: account?.email ?? null,
      // ⚠️ 資料庫裡可能有這一版不認得的角色（日後新增的）。退回 editor 是
      // 保守的選擇：顯示成權限比較小的那個，不要把不認得的東西當管理員。
      role: parseRole(r.role) ?? ("editor" as AdminRole),
      created_at: r.created_at,
      last_sign_in_at: account?.last_sign_in_at ?? null,
    };
  });
}

/** 目前有幾位管理員。給「刪掉他就沒有管理員了」的事前檢查用。 */
export async function countManagers(): Promise<number> {
  if (!hasSupabase()) return 0;
  const db = createAdminSupabase();
  const { count, error } = await db
    .from("user_roles")
    .select("user_id", { count: "exact", head: true })
    .eq("role", "admin");
  if (error) {
    if (isMissingTable(error)) throw new MissingTableError();
    throw new Error(`讀取管理員人數失敗：${error.message}`);
  }
  return count ?? 0;
}

/**
 * 授予角色。一個人只會有一個層級。
 *
 * 🔴 **先刪掉其他層級的列，再插入這一個。順序不能反。**
 *
 * PostgREST 的兩次呼叫不在同一個交易裡，所以中途失敗一定會留下半套。
 * 兩種順序留下的半套不一樣：
 *
 *   先刪後插：刪成功、插失敗 → 這個人暫時沒有角色（進不了後台，再授權一次就好）
 *   先插後刪：插成功、刪失敗 → 這個人**同時是管理員與小編**
 *
 * 後者更糟，而且它會正面打穿 keep_one_admin：把唯一的管理員降成小編時，
 * 「插入 editor」會先成功，接著「刪除 admin」被 trigger 擋下——結果那個人
 * 保有 admin，畫面上卻顯示成小編。先刪後插的話，那個 delete 會直接失敗，
 * 什麼都沒改，訊息也正確。
 */
export async function grantRole(userId: string, role: AdminRole): Promise<void> {
  const db = createAdminSupabase();

  const del = await db.from("user_roles").delete().eq("user_id", userId).neq("role", role);
  if (del.error) {
    if (isMissingTable(del.error)) throw new MissingTableError();
    throw friendly(del.error);
  }

  const ins = await db.from("user_roles").insert({ user_id: userId, role });
  if (ins.error) {
    // 23505 = 已經有這一列了（unique (user_id, role)）。這就是想要的結果。
    if (ins.error.code === "23505") return;
    if (isMissingTable(ins.error)) throw new MissingTableError();
    throw friendly(ins.error);
  }
}

/**
 * 移除後台權限。
 *
 * ⚠️ **帳號會留著**，只是拿掉 user_roles 的列。這是可逆的：在「新增人員」
 * 填同一個信箱就會加回來，而且密碼不變。跟「刪除帳號」是兩件事，
 * 介面上也要把這個差別講出來。
 *
 * ⚠️ 最後一位管理員會被 0006 的 trigger 擋下（LAST_ADMIN）。
 */
export async function revokeRole(userId: string): Promise<void> {
  const db = createAdminSupabase();
  const { error } = await db.from("user_roles").delete().eq("user_id", userId);
  if (error) {
    if (isMissingTable(error)) throw new MissingTableError();
    throw friendly(error);
  }
}
