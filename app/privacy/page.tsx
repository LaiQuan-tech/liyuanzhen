import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { site } from "@/content/site";

export const metadata: Metadata = { title: "隱私權說明｜李元貞 × AI 數位人" };

/**
 * ⚠️ 這一頁跟功能是綁在一起的，不是寫完就放著的公關文件。
 *
 * 新增一條會離開瀏覽器的資料流，就要同步改這裡——語音頁（/live）
 * 帶進來的錄音與串流影像都是性質不同的新資料流，不能等到之後再補。
 *
 * 目前尚未列入、但 /live 對外之後**必須**補上的（見 docs/AVATAR-RUNBOOK.md
 * 護欄清單第 10 項）：LiveAvatar 會拿到回答文字，WebRTC 連線還會讓對方
 * 取得訪客 IP。那要跟肖像授權的文案一起改，屬於 P5。
 */
const SECTIONS = [
  {
    h: "我們會記錄什麼",
    p: "你在對話中輸入的問題、系統的回答摘要，以及一組隨機產生的工作階段編號。這些用來改善回答品質、整理讀者常見問題。我們不會要求你登入，也不會蒐集姓名、電話或電子郵件，除非你主動填寫表單。",
  },
  {
    h: "語音提問會錄下你的聲音",
    p: "在「面對面問她」頁面按住說話時，瀏覽器會錄下這段聲音，送到 Google Gemini 轉成文字。轉完就丟棄，我們不保存音檔，也不會拿你的聲音去訓練任何模型或建立聲紋。轉出來的文字會跟一般提問一樣被記錄。你隨時可以拒絕麥克風權限，改用文字版對話。",
  },
  {
    h: "請不要輸入個人資料",
    p: "對話內容會被完整記錄，語音提問也會先轉成文字再記錄。請不要在提問中輸入或說出身分證字號、電話、住址或其他敏感個資。",
  },
  {
    h: "我們使用的第三方服務",
    p: "對話生成與語音轉文字都使用 Google Gemini；本站部署於 Vercel。你的提問文字會傳送給 Google 以產生回答；使用語音提問時，錄下的音訊也會傳送給 Google 轉成文字。",
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
