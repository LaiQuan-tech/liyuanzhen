import type { Metadata } from "next";
import LiveStage from "@/components/live/LiveStage";
import { POSE_STANDING } from "@/components/avatar/full-body-stage";

export const metadata: Metadata = {
  title: "面對面問她（站姿）｜李元貞 × AI 數位人",
};

/**
 * `/live` 的第二個版本，只有底圖的姿勢不同（站著、捧著一本翻開的書）。
 *
 * 頁面本身跟 `/live` 一樣是一層薄殼，同樣**刻意不掛** `<Nav />` 與 `<Footer />`
 * ——這一頁的重點就是那個佔滿螢幕的人，上下各一條列會把它切碎。
 * 代價是頁首頁尾常駐的揭露不會跟過來，所以 LiveStage 自己把 AVATAR_NAME、
 * ANSWER_DISCLAIMER、SITE_NOTICE 與影片上的常駐浮水印全部放回畫面上。
 * 那不是可選的裝飾，見該元件的檔頭。
 *
 * 🔴 這一頁**沒有**從導覽列或首頁連過來，是刻意的：一般訪客只該看到一個
 * 「面對面問她」的入口，多一個會讓人不知道該點哪個。這一頁靠網址直接進，
 * 用途是拿給人看另一個版本。要對外開放的話，components/Nav.tsx、
 * app/page.tsx 的三處 CTA 與 app/sitemap.ts 都要一起加。
 *
 * 🔴 兩頁各自會開一個**計費中**的 LiveAvatar session。同時開著就是兩份錢。
 */
export default function LiveStandingPage() {
  return <LiveStage pose={POSE_STANDING} />;
}
