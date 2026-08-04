import type { Metadata } from "next";
import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";

export const metadata: Metadata = { title: "活動報名｜李元貞 × AI 數位人" };

export default function EventsPage() {
  return (
    <>
      <Nav />
      <main className="lz-wrap py-12 md:py-16">
        <span className="lz-eyebrow">活動</span>
        <h1 className="lz-h2 mt-4">新書發表會，敬請期待。</h1>
        <p className="lz-lead mt-4">
          新書發表會的時間、地點與報名方式，將在確認後於此公布。
        </p>

        <div className="lz-card mt-9 p-6">
          <span className="lz-pill">尚未開放</span>
          <h2 className="lz-h3 mt-3">線上報名功能已備妥</h2>
          <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">
            正式版會在這裡提供發表會報名表單，報名資料直接進入後台名單並可匯出，
            同時串接電子報訂閱，為第二階段的實體展覽先累積觀眾。
            目前為提案展示版，尚未開放填寫。
          </p>
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/chat" className="lz-cta">
            先去問問數位李元貞 →
          </Link>
          <Link href="/book" className="lz-cta-ghost">
            看看著作
          </Link>
        </div>
      </main>
      <Footer />
    </>
  );
}
