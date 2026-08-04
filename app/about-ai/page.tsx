import type { Metadata } from "next";
import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";

export const metadata: Metadata = { title: "關於這個 AI｜李元貞 × AI 數位人" };

const FACTS = [
  {
    q: "「數位李元貞」是誰？",
    a: "它是一個 AI 分身，不是李元貞老師本人。它依據公開資料回答問題，說出來的話不代表老師的立場，老師也無須為它的內容負責。",
  },
  {
    q: "它怎麼運作？",
    a: "我們把公開資料整理成知識庫。你提問時，系統先從知識庫找出最相關的段落，再請 Google Gemini 依照這些段落作答。找不到夠相關的段落時，它會直接婉拒，而不是自己編一個答案。",
  },
  {
    q: "資料從哪裡來？",
    a: "全部取自公開來源：維基百科、婦女新知基金會的公開沿革、公開的報導與訪談。本站沒有使用任何未出版的書稿。",
  },
  {
    q: "為什麼頭像不是老師的臉？",
    a: "因為我們還沒有取得肖像授權。在授權之前，使用她的照片、繪製她的人像、或用 AI 生成她的面孔都不恰當，所以我們用一個「李」字標記代替。正式版會在取得授權與影像素材後，才換成老師本人的形象。",
  },
  {
    q: "它會答錯嗎？",
    a: "會。AI 生成的內容可能有誤，重要資訊請以老師的著作與正式出版品為準。若你發現錯誤，非常歡迎告訴我們，我們會直接修正知識庫。",
  },
  {
    q: "我的提問會被記錄嗎？",
    a: "提問內容會被記錄下來，用於改善回答品質與整理常見問題。請不要在對話中輸入個人資料。",
  },
];

export default function AboutAiPage() {
  return (
    <>
      <Nav />
      <main className="lz-wrap py-12 md:py-16">
        <span className="lz-eyebrow">關於這個 AI</span>
        <h1 className="lz-h2 mt-4">
          用她的名字說話，
          <br />
          更要說清楚。
        </h1>

        <div className="lz-card-wash mt-8 p-5 text-[14.5px] leading-relaxed">
          <strong>這是提案展示版。</strong>
          本網站由萊乾資訊製作，用來向李元貞老師展示「新書互動網站」的實際樣貌。
          目前尚未取得老師的肖像與內容授權，知識庫僅取自公開資料，
          網站也設定為不被搜尋引擎收錄。
        </div>

        <div className="mt-10 space-y-4">
          {FACTS.map((f) => (
            <div key={f.q} className="lz-card p-5">
              <h2 className="font-display text-[17px] font-bold">{f.q}</h2>
              <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">{f.a}</p>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap gap-3">
          <Link href="/chat" className="lz-cta">
            我了解了，開始對話 →
          </Link>
          <Link href="/privacy" className="lz-cta-ghost">
            隱私權說明
          </Link>
        </div>
      </main>
      <Footer />
    </>
  );
}
