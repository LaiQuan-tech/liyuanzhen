import type { Metadata } from "next";
import LiveStage from "@/components/live/LiveStage";
import { POSE_STANDING } from "@/components/avatar/full-body-stage";

export const metadata: Metadata = {
  title: "虛擬互動（站姿）｜李元貞 × AI 數位人",
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
 * 導覽列有這一項（「虛擬互動（站姿）」），sitemap 也有。
 * ⚠️ 但首頁與活動頁的 CTA 按鈕仍然指向 /live——主行動只能有一個，
 * 兩顆一樣大的按鈕等於沒有主行動。
 *
 * 🔴 兩頁各自會開一個**計費中**的 LiveAvatar session。同時開著就是兩份錢。
 */
export default function LiveStandingPage() {
  return <LiveStage pose={POSE_STANDING} />;
}
