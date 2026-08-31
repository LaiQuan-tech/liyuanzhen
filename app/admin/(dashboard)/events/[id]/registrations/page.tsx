import Link from "next/link";
import { notFound } from "next/navigation";
import { getEvent, listRegistrations, formatEventDate } from "@/lib/events";
import CsvButton from "./CsvButton";

export const dynamic = "force-dynamic";
export const metadata = { title: "報名名單｜活動後台" };

export default async function RegistrationsPage({ params }: { params: { id: string } }) {
  const event = await getEvent(params.id);
  if (!event) notFound();

  const rows = await listRegistrations(event.id);
  const people = rows.reduce((sum, r) => sum + (r.party_size ?? 1), 0);

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="font-display text-[20px] font-extrabold">{event.title}</h1>
          <p className="mt-1 text-[13.5px] text-muted">
            {formatEventDate(event.event_date)}　報名 {rows.length} 筆／{people} 人
          </p>
        </div>
        <div className="flex items-center gap-4">
          <CsvButton
            filename={`${event.slug}-報名名單.csv`}
            rows={rows.map((r) => ({
              報名時間: r.created_at,
              姓名: r.name,
              電子郵件: r.email,
              電話: r.phone ?? "",
              人數: String(r.party_size),
              備註: r.note ?? "",
            }))}
          />
          <Link
            href={`/admin/events/${event.id}`}
            className="text-[13.5px] text-muted underline underline-offset-4 hover:text-ink"
          >
            回場次設定
          </Link>
        </div>
      </div>

      {/*
        ⚠️ 這一頁畫面上就是姓名、信箱、電話。提醒不是裝飾——
        後台常常會在有其他人在場的時候被打開（會議、投影）。
      */}
      <p className="mt-4 rounded-lg bg-brand-wash px-4 py-2.5 text-[12.5px] leading-relaxed text-ink-soft">
        這一頁含有報名者的個人資料。請不要投影、截圖轉傳，或匯出後放在共用資料夾。
      </p>

      {rows.length === 0 ? (
        <p className="mt-10 text-[14.5px] text-muted">還沒有人報名。</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-[14px]">
            <thead>
              <tr className="border-b-[1.5px] border-ink/20 text-left">
                <th className="py-2 pr-4 font-bold">姓名</th>
                <th className="py-2 pr-4 font-bold">電子郵件</th>
                <th className="py-2 pr-4 font-bold">電話</th>
                <th className="py-2 pr-4 font-bold">人數</th>
                <th className="py-2 pr-4 font-bold">備註</th>
                <th className="py-2 font-bold">報名時間</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-ink/10 align-top">
                  <td className="py-2.5 pr-4">{r.name}</td>
                  <td className="py-2.5 pr-4 break-all">{r.email}</td>
                  <td className="py-2.5 pr-4 tabular-nums">{r.phone ?? "—"}</td>
                  <td className="py-2.5 pr-4 tabular-nums">{r.party_size}</td>
                  <td className="max-w-[18rem] py-2.5 pr-4 text-[13px] text-ink-soft">
                    {r.note ?? "—"}
                  </td>
                  <td className="py-2.5 text-[12.5px] tabular-nums text-muted">
                    {r.created_at.slice(0, 16).replace("T", " ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
