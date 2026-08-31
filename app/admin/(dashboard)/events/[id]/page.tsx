import Link from "next/link";
import { notFound } from "next/navigation";
import EventForm from "@/components/admin/EventForm";
import { getEvent } from "@/lib/events";

export const dynamic = "force-dynamic";
export const metadata = { title: "編輯場次｜活動後台" };

export default async function EditEventPage({ params }: { params: { id: string } }) {
  const event = await getEvent(params.id);
  if (!event) notFound();

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-display text-[20px] font-extrabold">編輯場次</h1>
        <div className="flex gap-4 text-[13.5px]">
          <Link
            href={`/admin/events/${event.id}/registrations`}
            className="text-muted underline underline-offset-4 hover:text-ink"
          >
            看報名名單
          </Link>
          {/* 草稿沒有公開頁可看，連過去只會拿到 404 */}
          {event.status !== "draft" && (
            <Link
              href={`/events/${event.slug}`}
              className="text-muted underline underline-offset-4 hover:text-ink"
            >
              看公開頁
            </Link>
          )}
        </div>
      </div>
      <EventForm event={event} />
    </>
  );
}
