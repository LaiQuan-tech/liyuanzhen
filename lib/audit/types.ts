/**
 * 操作稽核日誌的型別與純函式。
 *
 * ⚠️ 這個檔案**不碰資料庫**，全是純函式，所以測得到。
 * 任何需要 supabase client 的東西放 index.ts。
 *
 * 🔴 這份日誌**只記「誰、什麼時候、對哪一筆、做了什麼」，不存前後值 diff。**
 * 存 diff 看起來比較完整，但場次底下掛著報名者的姓名、email、電話——
 * 一旦記錄前後值，那些個資就會被複製一份到日誌裡，而日誌是給所有管理員
 * 看的、而且是 append-only 刪不掉的。那是隱私的倒退，不是稽核的進步。
 */

/**
 * 做了什麼。
 *
 * 🔴 這個 union 與 `supabase/migrations/0006_admin_users_and_audit.sql` 的
 * `admin_audit_log_action_valid` CHECK constraint 是**同一份合約的兩半**。
 * 改一邊一定要改另一邊：這裡多一個值而 SQL 沒加，寫入會被 CHECK 擋下——
 * 而 writeAudit 不會往上丟錯，所以那一筆會靜默消失。
 *
 * 🔴 revoke（移除權限，可逆）與 delete（刪帳號，不可逆）刻意分開。
 * 後台把這兩顆按鈕分開的全部理由就是可逆性不同，日誌不該把那個區分丟掉。
 */
export type AuditAction = "insert" | "update" | "delete" | "revoke" | "password";

/**
 * 上面那個 union 的執行期版本。
 *
 * ⚠️ 刻意寫成兩份（`type` 一份、陣列一份）而不是用 `as const` 互推。
 * 互推的話兩邊永遠一致，types.test.ts 那條對照就變成恆真的裝飾品；
 * 分開寫，漏掉一邊時測試才會紅。
 */
export const AUDIT_ACTIONS: readonly AuditAction[] = [
  "insert",
  "update",
  "delete",
  "revoke",
  "password",
];

export const ACTION_LABEL: Record<AuditAction, string> = {
  insert: "新增",
  update: "修改",
  delete: "刪除",
  revoke: "移除權限",
  password: "重設密碼",
};

/**
 * 對哪一種東西。
 *
 * ⚠️ 是**領域名詞**不是表名。「admin」一個詞要同時涵蓋 auth.users 與
 * user_roles 兩張表上的動作——那是應用層寫入才做得到的事，
 * DB trigger 手上只有 tg_table_name。
 */
export type AuditEntity = "event" | "admin";

export const AUDIT_ENTITIES: readonly AuditEntity[] = ["event", "admin"];

export const ENTITY_LABEL: Record<AuditEntity, string> = {
  event: "場次",
  admin: "後台人員",
};

/** 後台的篩選。值會出現在網址上，所以用英文短字。 */
export type AuditEntityFilter = AuditEntity | "all";

export const ENTITY_FILTER_LABEL: Record<AuditEntityFilter, string> = {
  all: "全部",
  event: "場次",
  admin: "後台人員",
};

/**
 * 網址上的 ?entity= 轉成篩選。
 *
 * ⚠️ **只接受已知值**，未知一律當「沒有篩選」。這個值會被接進查詢條件，
 * 照單全收就是把網址列開放給任何人當查詢語言用。
 */
export function parseEntityFilter(raw: string | undefined | null): AuditEntityFilter {
  return raw === "event" || raw === "admin" ? raw : "all";
}

/** 每頁筆數。跟問答紀錄同一個數字，兩頁的分頁手感才一致。 */
export const PAGE_SIZE = 100;

/**
 * 網址上的 ?page= 轉成頁碼。
 * 髒值（負數、文字、小數、空字串）一律當第 1 頁——後台不該因為有人亂改網址就 500。
 */
export function parsePage(raw: string | undefined | null): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 1;
  return n;
}

export function totalPages(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

/** 資料庫裡的一列。欄位名刻意跟 SQL 一致，不要在這一層改成 camelCase。 */
export interface AuditRow {
  id: number;
  /** ⚠️ 帳號被刪之後這裡仍然留著那個 uuid，但 auth.users 已經沒有那一列。 */
  actor_id: string | null;
  /** ⚠️ 快照，不 join。帳號刪掉之後仍然看得出是誰做的。 */
  actor_email: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  label: string | null;
  created_at: string;
}

/**
 * 操作者的顯示名稱。
 *
 * 快照是空的只有一種情況：那筆日誌寫進去時就沒拿到 email。
 * 顯示「（帳號已刪除）」而不是空白或一串 uuid——看日誌的人要的是
 * 「這是一個已經不存在的人」這個事實，不是他的內部編號。
 */
export function actorLabel(row: { actor_email: string | null }): string {
  return row.actor_email ?? "（帳號已刪除）";
}

/**
 * 被操作的對象。
 *
 * label 是寫入當下的快照（場次標題、人員 email）。拿不到就退回編號——
 * 「（編號 3f2a…）」至少還能拿去對資料，顯示空白則什麼都不剩。
 */
export function targetLabel(row: { label: string | null; entity_id: string | null }): string {
  if (row.label) return row.label;
  if (row.entity_id) return `（編號 ${row.entity_id}）`;
  return "—";
}

/** 認不得的 action／entity 也要顯示得出來——日誌是歷史，不該因為新版改了名就變空白。 */
export function actionLabel(action: string): string {
  return ACTION_LABEL[action as AuditAction] ?? action;
}

export function entityLabel(entity: string): string {
  return ENTITY_LABEL[entity as AuditEntity] ?? entity;
}

/**
 * `2026-09-21T00:30:00Z` → `2026/09/21 08:30`。
 *
 * 🔴 時區寫死 `Asia/Taipei`、`hourCycle: "h23"`。
 * 不指定時區的話，格式化會跟著伺服器所在地跑——Vercel 的函式跑在 UTC，
 * 於是「昨天下午五點做的事」會顯示成今天早上九點。稽核日誌的時間
 * 對不上人的記憶就失去意義。h23 是為了不要出現「上午 12:30」這種寫法。
 *
 * 🔴 最後那個 `.replace()` 不是裝飾。
 * `zh-TW` 的 ICU 資料在日期與時間之間放的是 **U+2009 THIN SPACE**，不是一般
 * 空白（Node 25 實測）。那個字元有兩個麻煩：
 *   1. 它**跟著 ICU 版本走**。本機與 Vercel 的 Node 版本不同時，同一份測試
 *      會在一邊綠、另一邊紅，而兩個字串在錯誤訊息裡長得一模一樣——
 *      這條測試第一次寫出來時就是這樣失敗的。
 *   2. 使用者把時間複製到 Excel 或搜尋框時，那個看不見的空白會讓比對失敗。
 * 統一換成一般空白，輸出才是可預測、可複製的。
 */
export function formatAuditTime(iso: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date(iso))
    .replace(/\s+/g, " ");
}
