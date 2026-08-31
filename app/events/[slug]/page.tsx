import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import SignupForm from "@/components/events/SignupForm";
import {
  getPublicEvent,
  formatEventDate,
  formatEventTime,
  acceptsRegistration,
} from "@/lib/events";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const event = await getPublicEvent(params.slug);
  if (!event) return { title: "找不到這個場次｜李元貞 × AI 數位人" };
  return {
    title: `${event.title}｜李元貞 × AI 數位人`,
    description: event.subtitle ?? undefined,
  };
}

export default async function EventDetailPage({ params }: { params: { slug: string } }) {
  const event = await getPublicEvent(params.slug);
  // ⚠️ 草稿也走這一條。對外一律當成不存在，不要洩漏「有這一場但還沒公開」
  if (!event) notFound();

  const time = formatEventTime(event.start_time, event.end_time);
  const open = acceptsRegistration(event.status);

  return (
    <>
      <Nav />
      <main className="lz-wrap py-12 md:py-16">
        <Link
          href="/events"
          className="text-[13.5px] text-muted underline underline-offset-4 hover:text-ink"
        >
          ← 所有場次
        </Link>

        <span className="lz-eyebrow mt-6 inline-block">{open ? "開放報名" : "已截止"}</span>
        <h1 className="lz-h2 mt-4">{event.title}</h1>
        {event.subtitle && <p className="lz-lead mt-3">{event.subtitle}</p>}

        <dl className="mt-8 grid gap-x-8 gap-y-3 text-[15px] sm:grid-cols-[auto_1fr]">
          <dt className="font-bold">時間</dt>
          <dd className="text-ink-soft">
            {formatEventDate(event.event_date)}
            {time && `　${time}`}
          </dd>
          {event.venue && (
            <>
              <dt className="font-bold">地點</dt>
              <dd className="text-ink-soft">
                {event.venue}
                {event.address && (
                  <span className="block text-[14px] text-muted">{event.address}</span>
                )}
              </dd>
            </>
          )}
        </dl>

        {event.description && (
          // ⚠️ whitespace-pre-line：後台是純文字輸入框，換行要保留。
          // 不要改成 dangerouslySetInnerHTML——那等於讓後台可以注入 HTML。
          <div className="mt-8 whitespace-pre-line text-[16px] leading-relaxed text-ink-soft">
            {event.description}
          </div>
        )}

        {open ? (
          <SignupForm slug={event.slug} note={event.registration_note} />
        ) : (
          <div className="lz-card mt-8 p-6">
            <h2 className="lz-h3">這一場已經截止報名</h2>
            <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">
              之後的場次會公布在活動頁。
            </p>
            <Link href="/events" className="lz-cta-ghost mt-5 inline-flex">
              看其他場次
            </Link>
          </div>
        )}
      </main>
      <Footer />
    </>
  );
}
