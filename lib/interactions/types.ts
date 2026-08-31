/**
 * 問答紀錄的型別與純函式。
 *
 * ⚠️ 這個檔案**不碰資料庫**，全是純函式，所以測得到。
 * 任何需要 supabase client 的東西放 index.ts。
 */

/** 提問從哪個介面來。null＝0005 之前的舊資料，補不回來。 */
export type InteractionChannel = "chat" | "live";

/** 資料庫裡的一列。欄位名刻意跟 SQL 一致，不要在這一層改成 camelCase。 */
export interface InteractionRow {
  id: string;
  session_id: string;
  question_text: string;
  answer_summary: string;
  top_similarity: number | null;
  in_scope: boolean;
  blocked: boolean;
  failed: boolean;
  channel: InteractionChannel | null;
  created_at: string;
}

/**
 * 一筆紀錄實際發生了什麼事。
 *
 * 🔴 這四種的順序不能換，因為它們會同時成立：
 * 檢索失敗的那條路徑是 `failed=true` **而且** `in_scope=false`——
 * 照 in_scope 判就會變成「離題婉拒」，而那是系統故障，不是訪客問偏了。
 */
export type InteractionStatus = "ok" | "failed" | "blocked" | "out-of-scope";

export function classifyInteraction(row: {
  in_scope: boolean;
  blocked: boolean;
  failed: boolean;
}): InteractionStatus {
  if (row.failed) return "failed";
  if (row.blocked) return "blocked";
  if (!row.in_scope) return "out-of-scope";
  return "ok";
}

export const STATUS_LABEL: Record<InteractionStatus, string> = {
  ok: "正常",
  failed: "系統出錯",
  blocked: "護欄攔下",
  "out-of-scope": "離題婉拒",
};

/** 後台的篩選。值會出現在網址上，所以用英文短字。 */
export type InteractionFilter = "all" | "unanswered" | "failed";

export const FILTER_LABEL: Record<InteractionFilter, string> = {
  all: "全部",
  unanswered: "答不出來",
  failed: "系統出錯",
};

export function parseFilter(raw: string | undefined | null): InteractionFilter {
  return raw === "unanswered" || raw === "failed" ? raw : "all";
}

/** 每頁筆數。⚠️ 改這個數字會連帶改變 CSV 匯出的範圍，見 index.ts 的說明。 */
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

export const CHANNEL_LABEL: Record<InteractionChannel, string> = {
  chat: "文字",
  live: "語音",
};

/** 舊資料沒有 channel，顯示成「—」而不是「未知」——那是資料的年紀，不是錯誤。 */
export function channelLabel(channel: InteractionChannel | null): string {
  return channel ? CHANNEL_LABEL[channel] : "—";
}

/**
 * 造訪代號。
 *
 * ⚠️ 只取前 8 碼。完整的 session_id 沒有必要出現在畫面上——
 * 它的用途只是「把同一次造訪的追問排在一起」，不是識別特定的人。
 */
export function shortSession(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/** `2026-08-31T14:57:23.215071+00:00` → `2026-08-31 14:57`，跟報名名單同一套。 */
export function formatTimestamp(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/** 相似度顯示成百分比。null（舊資料或檢索失敗）回 "—"。 */
export function formatSimilarity(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${Math.round(value * 100)}%`;
}
