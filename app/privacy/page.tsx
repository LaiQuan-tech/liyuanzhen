import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { site } from "@/content/site";

export const metadata: Metadata = { title: "隱私權說明｜李元貞 × AI 數位人" };

const SECTIONS = [
  {
    h: "我們會記錄什麼",
    p: "你在對話中輸入的問題、系統的回答摘要，以及一組隨機產生的工作階段編號。這些用來改善回答品質、整理讀者常見問題。我們不會要求你登入，也不會蒐集姓名、電話或電子郵件，除非你主動填寫表單。",
  },
  {
    h: "請不要輸入個人資料",
    p: "對話內容會被完整記錄。請不要在提問中輸入身分證字號、電話、住址或其他敏感個資。",
  },
  {
    h: "我們使用的第三方服務",
    p: "對話生成使用 Google Gemini；本站部署於 Vercel。你的提問文字會傳送給 Google 以產生回答。",
  },
  {
    h: "Cookie",
    p: "本站不使用追蹤 Cookie，也沒有安裝廣告或分析追蹤碼。",
  },
  {
    h: "這是展示版",
    p: "本站為提案展示版，未來正式上線時，隱私權政策會依實際功能（電子報、活動報名等）重新調整並公告。",
  },
];

export default function PrivacyPage() {
  return (
    <>
      <Nav />
      <main className="lz-wrap py-12 md:py-16">
        <span className="lz-eyebrow">隱私權</span>
        <h1 className="lz-h2 mt-4">我們蒐集什麼，說清楚。</h1>

        <div className="mt-9 space-y-6">
          {SECTIONS.map((s) => (
            <section key={s.h}>
              <h2 className="lz-h3">{s.h}</h2>
              <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">{s.p}</p>
            </section>
          ))}
        </div>

        <p className="mt-10 text-[13.5px] text-muted">
          有任何疑問，請聯絡本站製作單位 {site.builder}。
        </p>
      </main>
      <Footer />
    </>
  );
}
