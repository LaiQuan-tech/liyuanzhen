import Link from "next/link";
import {
  listAllEvents,
  countRegistrations,
  formatEventDate,
  formatEventTime,
  MissingTableError,
} from "@/lib/events";
import type { EventStatus } from "@/lib/events";

export const dynamic = "force-dynamic";
export const metadata = { title: "活動後台" };

/** 狀態徽章。⚠️ 顏色跟語意要對上：草稿是灰的、已發布是實心的、已截止是描邊的。 */
const BADGE: Record<EventStatus, { label: string; className: string }> = {
  draft: { label: "草稿", className: "bg-ink/10 text-ink-soft" },
  published: { label: "已發布", className: "bg-violet text-white" },
  closed: { label: "已截止", className: "border-[1.5px] border-ink/40 text-muted" },
};

export default async function AdminEventsPage() {
  let events, counts;
  try {
    [events, counts] = await Promise.all([listAllEvents(), countRegistrations()]);
  } catch (error) {
    // 🔴 資料表還沒建立時要講清楚是哪一步沒做。
    // 讓它變成 500 的話，畫面上只有 "Application error"，
    // 而真正的動作（去跑那份 SQL）完全看不出來。
    if (error instanceof MissingTableError) {
      return (
        <div className="max-w-xl">
          <h1 className="font-display text-[20px] font-extrabold">資料表還沒建立</h1>
          <p className="mt-3 text-[14.5px] leading-relaxed text-ink-soft">
            請把 <code className="text-[13px]">supabase/migrations/0004_events_admin.sql</code>{" "}
            貼到 Supabase Dashboard 的 SQL Editor 跑一次，然後重新整理這一頁。
          </p>
          <p className="mt-3 text-[13.5px] text-muted">
            那份 SQL 的第五節也寫了怎麼建立第一個管理員帳號。
          </p>
        </div>
      );
    }
    throw error;
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-[20px] font-extrabold">場次</h1>
        <Link
          href="/admin/events/new"
          className="rounded-full bg-ink px-5 py-2.5 font-display text-[14px] font-bold text-white"
        >
          新增場次
        </Link>
      </div>

      {events.length === 0 ? (
        <p className="mt-10 text-[14.5px] text-muted">
          還沒有任何場次。按右上角「新增場次」建第一場。
          <br />
          新建的場次預設是<strong>草稿</strong>，公開頁看不到；改成「已發布」才會出現。
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-ink/10 border-y border-ink/10">
          {events.map((event) => {
            const badge = BADGE[event.status];
            const count = counts.get(event.id);
            return (
              <li key={event.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11.5px] font-bold ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                    <Link
                      href={`/admin/events/${event.id}`}
                      className="font-display text-[16px] font-bold underline-offset-4 hover:underline"
                    >
                      {event.title}
                    </Link>
                  </div>
                  <p className="mt-1 text-[13px] text-muted">
                    {formatEventDate(event.event_date)}
                    {formatEventTime(event.start_time, event.end_time) &&
                      `　${formatEventTime(event.start_time, event.end_time)}`}
                    {event.venue && `　${event.venue}`}
                    <span className="ml-2 text-muted-light">/{event.slug}</span>
                  </p>
                </div>

                <Link
                  href={`/admin/events/${event.id}/registrations`}
                  className="shrink-0 rounded-lg border-[1.5px] border-ink/25 px-3 py-1.5 text-[13px] font-bold hover:border-ink"
                >
                  報名 {count ? `${count.rows} 筆／${count.people} 人` : "0"}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
