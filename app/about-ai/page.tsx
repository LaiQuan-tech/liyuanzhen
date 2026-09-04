import type { Metadata } from "next";
import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";

export const metadata: Metadata = { title: "資訊聲明｜李元貞 × AI 數位人" };

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
    a: "最主要的來源是李元貞老師的自傳《我來了！臺灣婦女改變了》（李元貞口述、王瑞香執筆），全文由出版者財團法人婦女權益促進發展基金會提供並授權本站使用——基金會也是本站的所有權人。其餘取自公開來源：維基百科、婦女新知基金會的公開沿革、公開的報導與訪談。",
  },
  {
    q: "影片裡是李元貞老師本人嗎？",
    a: "臉和聲音是她的，話不是。老師書面授權我們使用她的肖像與聲音；影片是 AI 依照文字即時生成的對嘴畫面，她本人從來沒有對著鏡頭說過這些話。所以畫面上永遠有「AI 生成影像」的標記，那個標記不會關掉。",
  },
  {
    q: "她的聲音是怎麼來的？",
    a: "是依老師本人的錄音訓練出來的合成音，同樣在書面授權的範圍內。它只會唸出這個系統當下生成的回答，不會、也無法拿去說別的話。",
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
        <span className="lz-eyebrow">資訊聲明</span>
        <h1 className="lz-h2 mt-4">
          用她的名字說話，
          <br />
          更要說清楚。
        </h1>

        {/*
          ⚠️ 這段是硬編的，沒有引用 content/site.ts——刻意保留這個狀態，
          因為它比 SITE_NOTICE 講得更長、更細，是這一頁存在的理由。
          但兩邊的說法不可以互相矛盾，改一邊記得看另一邊。
        */}
        <div className="lz-card-wash mt-8 p-5 text-[14.5px] leading-relaxed">
          <strong>先說清楚：這不是李元貞老師本人。</strong>
          「數位李元貞」是一個 AI 分身。老師的肖像與聲音經書面授權使用，
          知識庫取自她的著作與公開資料；但回答是 AI 生成的，
          不代表她的立場，她也無須為內容負責。
          本網站設定為不被搜尋引擎收錄。
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
