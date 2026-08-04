import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import DigitalAvatar from "@/components/avatar/DigitalAvatar";
import { OPENING_QUESTIONS } from "@/content/suggested-questions";

// 已上線的入口才給連結；其餘標「建置中」不連出去，避免點到 404
const ENTRIES = [
  { href: "/chat", n: "01", k: "與數位人對話", d: "文字提問，虛擬分身即時回答婦運史與老師的生平。", ready: true },
  { href: "/timeline", n: "02", k: "婦運互動時間軸", d: "從投身婦運到《眾女成城》，點下事件就接著說那段故事。", ready: false },
  { href: "/book", n: "03", k: "新書與著作", d: "著作介紹與導讀，讀了想買，一鍵導向購書。", ready: false },
  { href: "/quotes", n: "04", k: "金句分享卡", d: "把思想與書摘做成卡片，一鍵分享讓故事自己擴散。", ready: false },
];

export default function HomePage() {
  return (
    <>
      <Nav />

      <main>
        {/* Hero */}
        <section className="lz-section bg-brand">
          <div className="lz-wrap text-center">
            <span className="lz-eyebrow !bg-ink">新書互動網站 · 提案展示版</span>
            <h1 className="lz-h1 mt-6">
              李元貞 ×<br />
              AI 數位人
            </h1>
            <p className="lz-lead mx-auto mt-6 !text-ink-soft">
              一個線上就能和「數位李元貞」對話的新書網站——
              問婦女運動的歷史，問新書的故事，聽她親口回答。
            </p>

            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Link href="/chat" className="lz-cta">
                開始對話 →
              </Link>
              <Link href="/timeline" className="lz-cta-ghost">
                看婦運時間軸
              </Link>
            </div>
          </div>
        </section>

        {/* 對話示範入口 */}
        <section className="lz-section">
          <div className="lz-wrap">
            <div className="lz-device mx-auto max-w-[560px]">
              <div className="flex items-center gap-2 border-b-2 border-ink bg-paper-tint px-4 py-2.5">
                <span className="h-3 w-3 rounded-full border-[1.5px] border-ink bg-brand" />
                <span className="font-mono text-[11.5px] text-muted">數位李元貞（AI 模擬）</span>
              </div>

              <div className="space-y-4 px-5 py-6">
                <div className="flex justify-center pb-2">
                  <DigitalAvatar state="idle" />
                </div>
                <div className="lz-bubble-her text-[15px]">
                  您好，我是依公開資料建立的「數位李元貞」。想問我什麼呢？
                </div>
                <div className="flex flex-wrap justify-center gap-2 pt-1">
                  {OPENING_QUESTIONS.map((q) => (
                    <Link key={q} href={`/chat?q=${encodeURIComponent(q)}`} className="lz-chip">
                      {q}
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 四大入口 */}
        <section className="lz-section bg-paper-alt">
          <div className="lz-wrap-wide">
            <span className="lz-eyebrow">網站能做的事</span>
            <h2 className="lz-h2 mt-4">
              不只是數位人，
              <br />
              是一整座線上婦運展。
            </h2>

            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {ENTRIES.map((e) =>
                e.ready ? (
                  <Link key={e.href} href={e.href} className="lz-card p-5 transition hover:-translate-y-1">
                    <span className="lz-pill">{e.n}</span>
                    <h3 className="mt-3 font-display text-[17px] font-bold">{e.k}</h3>
                    <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{e.d}</p>
                  </Link>
                ) : (
                  <div key={e.href} className="lz-card p-5 opacity-60">
                    <span className="lz-pill !bg-white">{e.n}</span>
                    <h3 className="mt-3 font-display text-[17px] font-bold">
                      {e.k}
                      <span className="ml-2 align-middle text-[11px] font-medium text-muted-light">建置中</span>
                    </h3>
                    <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{e.d}</p>
                  </div>
                )
              )}
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
