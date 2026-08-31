import { createAdminSupabase, hasSupabase } from "../supabase";
import type {
  EventInput,
  EventRecord,
  EventStatus,
  RegistrationInput,
  RegistrationRecord,
} from "./types";

export * from "./types";

/**
 * 活動與報名的資料存取。
 *
 * ⚠️ 全部走 service_role（`createAdminSupabase`）。
 * 公開端的讀取也走它，理由是這個站只有一個 Supabase client 的心智模型比較安全——
 * 加第二把 anon key 的讀取路徑，總有一天會有人把它用在不該用的地方。
 * RLS 的 policy 仍然照設（見 0004_events_admin.sql），那是最後一道，不是唯一一道。
 *
 * ⚠️ 每一支公開端的查詢都**自己加 status 條件**，不要依賴 RLS——
 * service_role 繞過 RLS，忘了加條件就會把草稿送到公開頁上。
 */

/** 只把要給外面看的欄位列出來，避免哪天加了內部欄位就跟著漏出去。 */
const EVENT_COLUMNS =
  "id, title, slug, subtitle, description, event_date, start_time, end_time, venue, address, registration_note, status, created_at, updated_at";

function empty(): boolean {
  return !hasSupabase();
}

/**
 * 這個錯誤是不是「資料表還不存在」。
 *
 * 🔴 這個判斷存在的理由是部署順序。程式碼先上、SQL 後跑的那段空窗裡，
 * 每一次查詢都會失敗——而 `/events` 是一個公開頁，失敗的樣子是 500 白畫面。
 * Realreal 踩過同一件事（加欄位的 migration 沒先上 live DB，PostgREST 直接 500）。
 *
 * 公開端遇到這個錯就當作「沒有場次」，後台則要看到真正的原因。
 */
function isMissingTable(error: { code?: string; message?: string }): boolean {
  // 42P01 是 Postgres 的 undefined_table；PGRST205 是 PostgREST 找不到該 schema 快取
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /does not exist|Could not find the table/i.test(error.message ?? "")
  );
}

/** 後台專用：讓頁面能顯示「請先跑 migration」而不是 500。 */
export class MissingTableError extends Error {
  constructor() {
    super("活動的資料表還沒建立");
    this.name = "MissingTableError";
  }
}

/** 公開端：已發布與已截止的場次。⚠️ draft 絕不在內。 */
export async function listPublicEvents(): Promise<EventRecord[]> {
  if (empty()) return [];
  const db = createAdminSupabase();
  const { data, error } = await db
    .from("events")
    .select(EVENT_COLUMNS)
    .in("status", ["published", "closed"])
    .order("event_date", { ascending: true });
  if (error) {
    if (isMissingTable(error)) {
      console.error("[events] 資料表還不存在——請跑 supabase/migrations/0004_events_admin.sql");
      return [];
    }
    throw new Error(`讀取活動失敗：${error.message}`);
  }
  return (data ?? []) as EventRecord[];
}

/** 公開端：單一場次。找不到或還是草稿都回 null（對外一律當成不存在）。 */
export async function getPublicEvent(slug: string): Promise<EventRecord | null> {
  if (empty()) return null;
  const db = createAdminSupabase();
  const { data, error } = await db
    .from("events")
    .select(EVENT_COLUMNS)
    .eq("slug", slug)
    .in("status", ["published", "closed"])
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) {
      console.error("[events] 資料表還不存在——請跑 supabase/migrations/0004_events_admin.sql");
      return null;
    }
    throw new Error(`讀取活動失敗：${error.message}`);
  }
  return (data as EventRecord) ?? null;
}

/** 後台：全部場次，含草稿。呼叫端必須先過 requireAdmin()。 */
export async function listAllEvents(): Promise<EventRecord[]> {
  if (empty()) return [];
  const db = createAdminSupabase();
  const { data, error } = await db
    .from("events")
    .select(EVENT_COLUMNS)
    .order("event_date", { ascending: false });
  if (error) {
    if (isMissingTable(error)) throw new MissingTableError();
    throw new Error(`讀取活動失敗：${error.message}`);
  }
  return (data ?? []) as EventRecord[];
}

export async function getEvent(id: string): Promise<EventRecord | null> {
  if (empty()) return null;
  const db = createAdminSupabase();
  const { data, error } = await db
    .from("events")
    .select(EVENT_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`讀取活動失敗：${error.message}`);
  return (data as EventRecord) ?? null;
}

/** 空字串存成 null，資料庫裡才不會有一堆 `""` 要判斷。 */
function nullify(v: string): string | null {
  const t = v.trim();
  return t === "" ? null : t;
}

function toRow(input: EventInput) {
  return {
    title: input.title.trim(),
    slug: input.slug.trim(),
    subtitle: nullify(input.subtitle),
    description: nullify(input.description),
    event_date: input.event_date,
    start_time: nullify(input.start_time),
    end_time: nullify(input.end_time),
    venue: nullify(input.venue),
    address: nullify(input.address),
    registration_note: nullify(input.registration_note),
    status: input.status as EventStatus,
  };
}

/** slug 撞號時 Postgres 會回 23505。翻成人看得懂的話，不要把原始錯誤丟到畫面上。 */
function friendlyError(error: { code?: string; message: string }): Error {
  if (error.code === "23505") {
    return new Error("這個網址代稱已經有人用了，換一個");
  }
  return new Error(`儲存失敗：${error.message}`);
}

export async function createEvent(input: EventInput): Promise<string> {
  const db = createAdminSupabase();
  const { data, error } = await db.from("events").insert(toRow(input)).select("id").single();
  if (error) throw friendlyError(error);
  return data.id as string;
}

export async function updateEvent(id: string, input: EventInput): Promise<void> {
  const db = createAdminSupabase();
  const { error } = await db.from("events").update(toRow(input)).eq("id", id);
  if (error) throw friendlyError(error);
}

/**
 * 刪除場次。
 *
 * ⚠️ 報名紀錄會跟著被 cascade 刪掉（見 migration 的 on delete cascade）。
 * 所以介面上一定要二次確認，而且要把「連同 N 筆報名」講出來——
 * 那些是真人的姓名電話，刪掉就沒了。想留著紀錄就改成 closed，不要刪。
 */
export async function deleteEvent(id: string): Promise<void> {
  const db = createAdminSupabase();
  const { error } = await db.from("events").delete().eq("id", id);
  if (error) throw new Error(`刪除失敗：${error.message}`);
}

/** 每一場的報名人次（不是筆數，party_size 要加總）。後台列表用。 */
export async function countRegistrations(): Promise<Map<string, { rows: number; people: number }>> {
  const out = new Map<string, { rows: number; people: number }>();
  if (empty()) return out;
  const db = createAdminSupabase();
  const { data, error } = await db.from("event_registrations").select("event_id, party_size");
  if (error) {
    if (isMissingTable(error)) throw new MissingTableError();
    throw new Error(`讀取報名數失敗：${error.message}`);
  }
  for (const r of data ?? []) {
    const cur = out.get(r.event_id) ?? { rows: 0, people: 0 };
    cur.rows += 1;
    cur.people += r.party_size ?? 1;
    out.set(r.event_id, cur);
  }
  return out;
}

export async function listRegistrations(eventId: string): Promise<RegistrationRecord[]> {
  if (empty()) return [];
  const db = createAdminSupabase();
  const { data, error } = await db
    .from("event_registrations")
    .select("id, event_id, name, email, phone, party_size, note, consent, created_at")
    .eq("event_id", eventId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`讀取報名失敗：${error.message}`);
  return (data ?? []) as RegistrationRecord[];
}

export async function createRegistration(
  eventId: string,
  input: RegistrationInput
): Promise<void> {
  const db = createAdminSupabase();
  const { error } = await db.from("event_registrations").insert({
    event_id: eventId,
    name: input.name.trim(),
    email: input.email.trim(),
    phone: nullify(input.phone),
    party_size: input.party_size,
    note: nullify(input.note),
    consent: input.consent,
  });
  if (error) throw new Error(`報名寫入失敗：${error.message}`);
}
