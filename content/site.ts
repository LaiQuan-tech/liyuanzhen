/**
 * 全站文案與設定的單一來源。改文字改這裡，不要進 JSX。
 */

export const site = {
  name: "李元貞 × AI 數位人",
  title: "李元貞 × AI 數位人｜新書互動網站（提案展示版）",
  description:
    "一個線上就能和「數位李元貞」對話的新書網站——問婦女運動的歷史，問新書的故事。本站為提案展示版，內容由 AI 依公開資料生成。",
  builder: "萊乾資訊 LaiQuan Tech",
  builderUrl: "https://laiquan.co",
} as const;

/** 數位人的顯示名稱——刻意永遠帶著「AI 模擬」，不做成可關閉的橫幅 */
export const AVATAR_NAME = "數位李元貞（AI 模擬）";

/** 每一則 AI 回答下方都必須出現這句，不可省略 */
export const ANSWER_DISCLAIMER =
  "本回答由 AI 依公開資料生成，非李元貞老師本人發言。";

/** 頁首常駐標記 */
export const DEMO_BADGE = "提案展示版";

export const DEMO_NOTICE =
  "本網站為萊乾資訊製作的提案展示版，尚未取得李元貞老師的肖像與內容授權，知識庫僅取自公開資料。";

/** 超出知識庫範圍時的婉拒文案（不呼叫 LLM，直接回這段） */
export const OUT_OF_SCOPE_REPLY =
  "這個問題超出我手上資料的範圍，我不便隨口回答。我能談的是李元貞老師的生平、婦女新知的創辦過程，以及台灣婦女運動的重要歷程。";

/** 觸發封鎖清單時的替代回答 */
export const GUARDED_REPLY =
  "這部分我不便代為表態。我能談的是李元貞老師的婦運歷程與著作，要不要換個方向問問看？";

/**
 * 只列已完成的頁面——導覽列連到 404 在客戶面前是最沒必要的失分。
 * 時間軸／金句／提問牆／關於李元貞完成後再加回來。
 */
export const nav = [
  { href: "/chat", label: "與數位人對話" },
  { href: "/events", label: "活動報名" },
  { href: "/about-ai", label: "關於這個 AI" },
] as const;

export const footerLinks = [
  { href: "/about-ai", label: "關於這個 AI" },
  { href: "/privacy", label: "隱私權" },
] as const;
