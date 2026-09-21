import type { User } from "@supabase/supabase-js";
import { createAdminSupabase, hasSupabase } from "../supabase";
import { PAGE_SIZE } from "./types";
import type { AuditAction, AuditEntity, AuditEntityFilter, AuditRow } from "./types";

export * from "./types";

/**
 * 操作稽核日誌的寫入與讀取。
 *
 * 🔴 這張表**由應用層寫入，不是 DB trigger**（理由寫在 0006 第四節）：
 * 這個站的後台寫入全部走 service_role，`auth.uid()` 永遠是 NULL，照抄
 * trigger 的作法會一筆都不記而且不報錯。更關鍵的是建帳號／設密碼／刪帳號
 * 都發生在 GoTrue，沒有任何 trigger 看得到。
 *
 * 🔴 `admin_audit_log` 的 RLS 是「開著、零 policy」＝只有 service_role 進得來。
 * 所以讀取也走 `createAdminSupabase()`，呼叫端必須先過 `requireManager()`。
 */

/**
 * 這個錯誤是不是「資料表還不存在」。
 *
 * ⚠️ 形狀照抄 `lib/events/index.ts` 的同名函式，但**刻意各自寫一份**。
 * 那是那個模組的私有判斷，跨模組 import 會把兩邊綁在一起——日後
 * events 要多判一個 42703（undefined_column）時，不該連帶改變日誌的行為。
 */
function isMissingTable(error: { code?: string; message?: string }): boolean {
  // 42P01 是 Postgres 的 undefined_table；PGRST205 是 PostgREST 找不到該表
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /does not exist|Could not find the table/i.test(error.message ?? "")
  );
}

/** 後台專用：讓頁面能顯示「請先跑 migration」而不是 500。 */
export class MissingTableError extends Error {
  constructor() {
    super("稽核日誌的資料表還沒建立");
    this.name = "MissingTableError";
  }
}

const MIGRATION_HINT = "[audit] 請先跑 supabase/migrations/0006_admin_users_and_audit.sql";

export interface AuditEntry {
  action: AuditAction;
  entity: AuditEntity;
  /** 被操作的那一筆的編號。GoTrue 的帳號用 uuid，場次用 events.id。 */
  entityId?: string | null;
  /**
   * 寫入當下的名稱快照（場次標題、人員 email）。
   *
   * 🔴 **只放名稱，不要放內容。** 報名者的姓名／email／電話絕不能進來——
   * 日誌是 append-only 而且所有管理員都看得到，個資一旦複製進來就拿不出去。
   * 同理，`resetPasswordAction` 的 label 只寫「誰的密碼」，不寫密碼。
   */
  label?: string | null;
}

/**
 * 記一筆「誰、什麼時候、對哪一筆、做了什麼」。
 *
 * 🔴 **這支函式永遠不會往上丟例外。**
 *
 * 呼叫它的時候業務寫入已經成功了。為了「日誌沒寫進去」而讓一次成功的
 * 存檔看起來像失敗，使用者會再存一次、或以為資料沒進去——那比少一筆
 * 日誌糟得多。所以失敗只留 console.error，不影響呼叫端。
 *
 * ⚠️ 但**兩種失敗都要留 log**，不要完全吞掉。表不存在時要講出該跑哪份 SQL；
 * 其他錯誤要留下原始訊息，否則「日誌是空的」會變成一個查不下去的問題。
 */
export async function writeAudit(actor: User, entry: AuditEntry): Promise<void> {
  try {
    if (!hasSupabase()) {
      console.error(`${MIGRATION_HINT}（目前連 SUPABASE_URL 都沒設）`);
      return;
    }
    const db = createAdminSupabase();
    const { error } = await db.from("admin_audit_log").insert({
      actor_id: actor.id,
      // ⚠️ 存快照不是外鍵。這個帳號日後可能被刪掉，而那正是這張表會記錄的動作之一。
      actor_email: actor.email ?? null,
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entityId ?? null,
      label: entry.label ?? null,
    });
    if (error) {
      if (isMissingTable(error)) {
        console.error(MIGRATION_HINT);
        return;
      }
      console.error("[audit] 寫入失敗（業務操作已經成功，不回滾）：", error.code, error.message);
    }
  } catch (error) {
    // createAdminSupabase() 在缺環境變數時會丟，網路層也可能丟。
    console.error("[audit] 寫入時發生例外（業務操作已經成功，不回滾）：", error);
  }
}

export interface AuditPage {
  rows: AuditRow[];
  total: number;
  /**
   * 實際回傳的是第幾頁。
   *
   * 🔴 不一定等於呼叫端要求的頁碼。要求超出範圍時這裡會夾到最後一頁——
   * 呼叫端要用這個值顯示「第 N 頁」，用原本要求的值會顯示成一個不存在的頁數。
   */
  page: number;
  /** 各篩選的筆數，給篩選標籤上的數字用。 */
  counts: { all: number; event: number; admin: number };
}

const COLUMNS = "id, actor_id, actor_email, action, entity, entity_id, label, created_at";

/**
 * 一頁的稽核日誌。呼叫端必須先過 `requireManager()`。
 */
export async function listAudit(
  filter: AuditEntityFilter,
  page: number
): Promise<AuditPage> {
  if (!hasSupabase()) {
    return { rows: [], total: 0, page: 1, counts: { all: 0, event: 0, admin: 0 } };
  }

  const db = createAdminSupabase();

  // 三個計數一起拿，篩選列上的數字才不會跟實際內容對不上。
  const [all, event, admin] = await Promise.all([
    db.from("admin_audit_log").select("id", { count: "exact", head: true }),
    db.from("admin_audit_log").select("id", { count: "exact", head: true }).eq("entity", "event"),
    db.from("admin_audit_log").select("id", { count: "exact", head: true }).eq("entity", "admin"),
  ]);

  for (const r of [all, event, admin]) {
    if (r.error) {
      if (isMissingTable(r.error)) throw new MissingTableError();
      throw new Error(`讀取操作日誌失敗：${r.error.message}`);
    }
  }

  const counts = {
    all: all.count ?? 0,
    event: event.count ?? 0,
    admin: admin.count ?? 0,
  };
  const total = counts[filter];

  /*
   * 🔴 計數要先拿到，才能把頁碼夾進範圍內。
   *
   * PostgREST 對超出範圍的 .range() 回的是錯誤（"Requested range not satisfiable"），
   * 不是空陣列。所以 /admin/logs?page=99 會變成 500 白畫面——
   * 而網址上的頁碼是使用者改得到的，按上一頁按到底、書籤存了舊頁碼都會撞上。
   * parsePage() 夾得住下限（0、-3、abc），夾不住上限，因為它不知道總共幾頁。
   */
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const from = (safePage - 1) * PAGE_SIZE;

  // ⚠️ 篩選條件直接接在 builder 上，不要抽成泛型的 applyFilter()——
  // supabase-js 的 builder 型別很深，包一層泛型會讓 tsc 直接吐
  // 「Type instantiation is excessively deep」（lib/interactions 踩過）。
  const base = db
    .from("admin_audit_log")
    .select(COLUMNS)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  const list = await (filter === "all" ? base : base.eq("entity", filter));

  if (list.error) {
    if (isMissingTable(list.error)) throw new MissingTableError();
    throw new Error(`讀取操作日誌失敗：${list.error.message}`);
  }

  return {
    rows: (list.data ?? []) as unknown as AuditRow[],
    total,
    page: safePage,
    counts,
  };
}
