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
        <h1 className="lz-h2 mt-4">場次確認後，會在這裡公布。</h1>
        <p className="lz-lead mt-4">
          新書發表會的日期、地點與報名方式，確認之後會公布在這一頁。
        </p>

        {/*
          ⚠️ 這裡原本寫「線上報名功能已備妥…目前為提案展示版，尚未開放填寫」。
          那是空話：沒有表單元件、沒有 API route。而且真正的原因不是「還在展示版」，
          是**目前沒有已排定的場次**——沒有東西可以報名。照實寫。
          資料表（event_signups）與 RLS 其實已經就緒，場次確定了再接表單。
        */}
        <div className="lz-card mt-9 p-6">
          <span className="lz-pill">尚未排定</span>
          <h2 className="lz-h3 mt-3">目前沒有可以報名的場次</h2>
          <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">
            等時間與地點確認之後，這裡會開放線上報名。
            在那之前，你可以先跟數位李元貞聊聊她的婦運歷程與著作。
          </p>
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/live" className="lz-cta">
            面對面問她 →
          </Link>
          {/* 原本連 /book，但那個路由不存在——是站上兩個 404 之一 */}
          <Link href="/chat?q=李元貞寫過哪些書？" className="lz-cta-ghost">
            問她寫過哪些書
          </Link>
        </div>
      </main>
      <Footer />
    </>
  );
}
