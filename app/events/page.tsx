import type { Metadata } from "next";
import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { listPublicEvents, formatEventDate, formatEventTime } from "@/lib/events";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "活動報名｜李元貞 × AI 數位人" };

export default async function EventsPage() {
  const events = await listPublicEvents();

  return (
    <>
      <Nav />
      <main className="lz-wrap py-12 md:py-16">
        <span className="lz-eyebrow">活動</span>

        {events.length === 0 ? (
          <>
            <h1 className="lz-h2 mt-4">場次確認後，會在這裡公布。</h1>
            <p className="lz-lead mt-4">
              新書發表會的日期、地點與報名方式，確認之後會公布在這一頁。
            </p>
            {/*
              ⚠️ 這段文案要照實寫。原本寫過「線上報名功能已備妥，目前為提案展示版」，
              那是空話——沒有表單也沒有 API。現在表單與 API 都真的有了，
              所以這裡唯一誠實的說法是「目前沒有已排定的場次」。
              後台上架一場並改成「已發布」，這一段就會被下面的列表取代。
            */}
            <div className="lz-card mt-9 p-6">
              <span className="lz-pill">尚未排定</span>
              <h2 className="lz-h3 mt-3">目前沒有可以報名的場次</h2>
              <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">
                等時間與地點確認之後，這裡會開放線上報名。
                在那之前，你可以先跟數位李元貞聊聊她的婦運歷程與著作。
              </p>
            </div>
          </>
        ) : (
          <>
            <h1 className="lz-h2 mt-4">近期場次</h1>
            <p className="lz-lead mt-4">點進去看詳細內容，並在頁面上直接報名。</p>

            <ul className="mt-9 space-y-4">
              {events.map((event) => {
                const time = formatEventTime(event.start_time, event.end_time);
                const closed = event.status === "closed";
                return (
                  <li key={event.id}>
                    <Link
                      href={`/events/${event.slug}`}
                      className="lz-card block p-6 transition-transform duration-200 hover:-translate-x-[1px] hover:-translate-y-[2px]"
                    >
                      <span className="lz-pill">{closed ? "已截止" : "開放報名"}</span>
                      <h2 className="lz-h3 mt-3">{event.title}</h2>
                      {event.subtitle && (
                        <p className="mt-1.5 text-[15px] text-ink-soft">{event.subtitle}</p>
                      )}
                      <p className="mt-3 text-[14px] text-muted">
                        {formatEventDate(event.event_date)}
                        {time && `　${time}`}
                        {event.venue && `　${event.venue}`}
                      </p>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/live" className="lz-cta">
            面對面問她 →
          </Link>
          <Link href="/chat?q=李元貞寫過哪些書？" className="lz-cta-ghost">
            問她寫過哪些書
          </Link>
        </div>
      </main>
      <Footer />
    </>
  );
}
