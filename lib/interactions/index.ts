import { createAdminSupabase, hasSupabase } from "../supabase";
import { PAGE_SIZE } from "./types";
import type { InteractionFilter, InteractionRow } from "./types";

export * from "./types";

/**
 * 訪客問答紀錄的讀取層。
 *
 * ⚠️ 走 service_role（`createAdminSupabase`），跟 lib/events 同一套心智模型：
 * 這個站只有一把 Supabase client。
 *
 * 🔴 `interactions` 的 RLS 是「開著、零 policy」＝只有 service_role 進得來。
 * 不要為了方便加 anon 的 select policy——提問是自由文字，訪客可能自己打了
 * 電話或住址進去，而 anon key 是寫在前端原始碼裡的。
 */

/** 明列欄位，不用 select("*")，免得哪天加了內部欄位就跟著送到畫面上。 */
const COLUMNS =
  "id, session_id, question_text, answer_summary, top_similarity, in_scope, blocked, failed, channel, created_at";

function empty(): boolean {
  return !hasSupabase();
}

/**
 * 這個錯誤是不是「欄位／資料表還不存在」。
 *
 * 🔴 部署順序：程式碼先上、SQL 後跑的那段空窗裡，後台這一頁每一次查詢都會失敗。
 * 42703 是 undefined_column——這一版新增了 `failed` 與 `channel`，
 * 0005 還沒跑的話會撞的是這個，不是 42P01。少判一個就會變成 500 白畫面，
 * 而畫面上只有 "Application error"，看不出真正該做的動作是去跑那份 SQL。
 */
function isMissingSchema(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "42P01" || // undefined_table
    error.code === "42703" || // undefined_column
    error.code === "PGRST204" || // PostgREST 找不到欄位
    error.code === "PGRST205" || // PostgREST 找不到資料表
    /does not exist|Could not find the (table|column)/i.test(error.message ?? "")
  );
}

/** 後台專用：讓頁面能顯示「請先跑 migration」而不是 500。 */
export class MissingSchemaError extends Error {
  constructor() {
    super("問答紀錄的欄位還沒建立");
    this.name = "MissingSchemaError";
  }
}

export interface InteractionPage {
  rows: InteractionRow[];
  total: number;
  /**
   * 實際回傳的是第幾頁。
   *
   * 🔴 不一定等於呼叫端要求的頁碼。要求超出範圍時這裡會夾到最後一頁——
   * 呼叫端要用這個值顯示「第 N 頁」，用原本要求的值會顯示成一個不存在的頁數。
   */
  page: number;
  /** 各篩選的筆數，給篩選標籤上的數字用。 */
  counts: { all: number; unanswered: number; failed: number };
}

/**
 * 一頁的問答紀錄。呼叫端必須先過 `requireAdmin()`。
 *
 * ⚠️ 這裡回傳的就是 CSV 匯出的範圍——`CsvButton` 是 client component，
 * 用的是這一頁 props 裡的資料。分頁與「匯出全部」在這個架構下是互斥的，
 * 所以按鈕上要明寫匯出幾筆，不做隱形截斷。
 */
export async function listInteractions(
  filter: InteractionFilter,
  page: number
): Promise<InteractionPage> {
  if (empty()) {
    return { rows: [], total: 0, page: 1, counts: { all: 0, unanswered: 0, failed: 0 } };
  }

  const db = createAdminSupabase();

  // 三個計數一起拿，篩選列上的數字才不會跟實際內容對不上。
  const [all, unanswered, failed] = await Promise.all([
    db.from("interactions").select("id", { count: "exact", head: true }),
    db.from("interactions").select("id", { count: "exact", head: true }).eq("in_scope", false),
    db.from("interactions").select("id", { count: "exact", head: true }).eq("failed", true),
  ]);

  for (const r of [all, unanswered, failed]) {
    if (r.error) {
      if (isMissingSchema(r.error)) throw new MissingSchemaError();
      throw new Error(`讀取問答紀錄失敗：${r.error.message}`);
    }
  }

  const counts = {
    all: all.count ?? 0,
    unanswered: unanswered.count ?? 0,
    failed: failed.count ?? 0,
  };
  const total = counts[filter];

  /*
   * 🔴 計數要先拿到，才能把頁碼夾進範圍內。
   *
   * PostgREST 對超出範圍的 .range() 回的是錯誤（"Requested range not satisfiable"），
   * 不是空陣列。所以 /admin/interactions?page=99 會變成 500 白畫面——
   * 而網址上的頁碼是使用者改得到的，按上一頁按到底、書籤存了舊頁碼都會撞上。
   * parsePage() 夾得住下限（0、-3、abc），夾不住上限，因為它不知道總共幾頁。
   */
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const from = (safePage - 1) * PAGE_SIZE;

  // ⚠️ 篩選條件用三元運算直接接在 builder 上，不要抽成泛型的 applyFilter()——
  // supabase-js 的 builder 型別很深，包一層泛型會讓 tsc 直接吐
  // 「Type instantiation is excessively deep」。這裡的分支要跟上面 counts 的定義一致。
  const base = db
    .from("interactions")
    .select(COLUMNS)
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  const list = await (filter === "unanswered"
    ? base.eq("in_scope", false)
    : filter === "failed"
      ? base.eq("failed", true)
      : base);

  if (list.error) {
    if (isMissingSchema(list.error)) throw new MissingSchemaError();
    throw new Error(`讀取問答紀錄失敗：${list.error.message}`);
  }

  return {
    rows: (list.data ?? []) as unknown as InteractionRow[],
    total,
    page: safePage,
    counts,
  };
}
