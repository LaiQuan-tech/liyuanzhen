/**
 * 活動與報名的型別與驗證。
 *
 * ⚠️ 這個檔案**不碰資料庫**，全是純函式，所以測得到。
 * 照 `lib/avatar-ledger/types.ts` 與 `lib/live/recorder.ts` 的既有紀律：
 * 會出錯的判斷抽成純函式，讓它可以被釘死在測試裡。
 */

export type EventStatus = "draft" | "published" | "closed";

export const EVENT_STATUSES: readonly EventStatus[] = ["draft", "published", "closed"];

/** 給後台下拉選單用。順序有意義：一場活動的生命週期就是這個順序。 */
export const STATUS_LABEL: Record<EventStatus, string> = {
  draft: "草稿（公開頁看不到）",
  published: "已發布（可以報名）",
  closed: "已截止（看得到，不能報名）",
};

export interface EventRecord {
  id: string;
  title: string;
  slug: string;
  subtitle: string | null;
  description: string | null;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  venue: string | null;
  address: string | null;
  registration_note: string | null;
  status: EventStatus;
  created_at: string;
  updated_at: string;
}

export interface RegistrationRecord {
  id: string;
  event_id: string;
  name: string;
  email: string;
  phone: string | null;
  party_size: number;
  note: string | null;
  consent: boolean;
  created_at: string;
}

/** 後台表單送上來的東西。全部都是字串，因為 HTML 表單只給得出字串。 */
export interface EventInput {
  title: string;
  slug: string;
  subtitle: string;
  description: string;
  event_date: string;
  start_time: string;
  end_time: string;
  venue: string;
  address: string;
  registration_note: string;
  status: string;
}

export const MAX_PARTY_SIZE = 10;

/**
 * 只有 published 可以報名。
 *
 * ⚠️ 這一條要在**伺服器端**再檢查一次，不是只在畫面上把按鈕藏起來。
 * 藏按鈕擋不住直接打 API 的人，而一場 closed 的活動收到報名，
 * 意味著有人會白跑一趟。
 */
export function acceptsRegistration(status: EventStatus): boolean {
  return status === "published";
}

export interface ValidationResult<T> {
  ok: boolean;
  errors: string[];
  value?: T;
}

/**
 * 驗證後台的活動表單。
 *
 * ⚠️ 回傳「所有錯誤」而不是第一個。一次只講一個錯，使用者要來回存五次
 * 才知道全部的問題——那是最惹人厭的表單。
 */
export function validateEvent(input: EventInput): ValidationResult<EventInput> {
  const errors: string[] = [];
  const title = input.title.trim();
  const slug = input.slug.trim();

  if (!title) errors.push("請填活動名稱");
  else if (title.length > 200) errors.push("活動名稱請控制在 200 字以內");

  if (!slug) {
    errors.push("請填網址代稱");
  } else if (!/^[a-z0-9-]+$/.test(slug)) {
    // ⚠️ 這個值會直接出現在網址 /events/{slug} 裡，所以不能有中文、空白或斜線。
    errors.push("網址代稱只能用小寫英文、數字與連字號");
  } else if (slug.length > 120) {
    errors.push("網址代稱請控制在 120 字以內");
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.event_date)) {
    errors.push("請填活動日期");
  }

  // 時間是選填的，但填了就要合法，而且結束不能早於開始
  const timeOk = (t: string) => t === "" || /^\d{2}:\d{2}(:\d{2})?$/.test(t);
  if (!timeOk(input.start_time)) errors.push("開始時間格式不正確");
  if (!timeOk(input.end_time)) errors.push("結束時間格式不正確");
  if (
    input.start_time &&
    input.end_time &&
    timeOk(input.start_time) &&
    timeOk(input.end_time) &&
    input.end_time < input.start_time
  ) {
    errors.push("結束時間不能早於開始時間");
  }

  if (!EVENT_STATUSES.includes(input.status as EventStatus)) {
    errors.push("狀態不正確");
  }

  if (input.description.length > 20_000) errors.push("活動介紹太長了");

  return errors.length ? { ok: false, errors } : { ok: true, errors: [], value: input };
}

export interface RegistrationInput {
  name: string;
  email: string;
  phone: string;
  party_size: number;
  note: string;
  consent: boolean;
}

/**
 * 驗證訪客的報名。
 *
 * ⚠️ 這一支的輸入來自公開網際網路，所有欄位都要當成惡意的來看：
 * 長度上限不是為了畫面好看，是為了不要讓人把資料庫塞爆。
 */
export function validateRegistration(
  input: RegistrationInput
): ValidationResult<RegistrationInput> {
  const errors: string[] = [];
  const name = input.name.trim();
  const email = input.email.trim();

  if (!name) errors.push("請填姓名");
  else if (name.length > 100) errors.push("姓名太長了");

  // 刻意用很寬鬆的規則。email 的正確性最後是靠「寄得到」決定的，
  // 在這裡用嚴格的正規表達式只會擋掉合法但少見的信箱。
  if (!email) errors.push("請填電子郵件");
  else if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push("電子郵件格式不正確");
  }

  if (input.phone.trim().length > 40) errors.push("電話太長了");

  if (
    !Number.isInteger(input.party_size) ||
    input.party_size < 1 ||
    input.party_size > MAX_PARTY_SIZE
  ) {
    errors.push(`人數請填 1 到 ${MAX_PARTY_SIZE} 之間`);
  }

  if (input.note.length > 1000) errors.push("備註太長了");

  // 🔴 沒有勾同意就不能收。這不是介面上的禮貌，是蒐集個資的前提。
  if (!input.consent) errors.push("需要勾選同意，我們才能保留你的報名資料");

  return errors.length ? { ok: false, errors } : { ok: true, errors: [], value: input };
}

/**
 * 把活動日期與時間組成給人看的字串。
 *
 * ⚠️ 不要用 `new Date(event_date)` 再 toLocaleDateString——`"2026-09-20"`
 * 會被當成 UTC 午夜解析，在台灣時區（UTC+8）顯示還是同一天沒錯，
 * 但在負時區的瀏覽器會變成前一天。活動日期是「牆上日曆的那一天」，
 * 不是一個時間點，所以直接拆字串。
 */
export function formatEventDate(date: string): string {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return date;
  return `${m[1]} 年 ${Number(m[2])} 月 ${Number(m[3])} 日`;
}

/** `"14:00:00"` → `"14:00"`。資料庫的 time 會帶秒，畫面上不需要。 */
export function formatEventTime(start: string | null, end: string | null): string {
  const trim = (t: string | null) => (t ? t.slice(0, 5) : "");
  const s = trim(start);
  const e = trim(end);
  if (s && e) return `${s}–${e}`;
  return s || e || "";
}
