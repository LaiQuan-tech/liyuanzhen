import type { Metadata } from "next";
import LiveStage from "@/components/live/LiveStage";

export const metadata: Metadata = {
  title: "面對面問她｜李元貞 × AI 數位人",
};

/**
 * 全螢幕的語音互動頁。
 *
 * ⚠️ 刻意**不掛** `<Nav />` 與 `<Footer />`——這一頁的重點就是那張佔滿螢幕的臉，
 * 上下各一條列會把它切碎。代價是頁首頁尾常駐的揭露不會跟過來，
 * 所以 LiveStage 自己把 AVATAR_NAME、ANSWER_DISCLAIMER、SITE_NOTICE
 * 與影片上的常駐浮水印全部放回畫面上。那不是可選的裝飾，見該元件的檔頭。
 *
 * ⚠️ 這段原本還列了 `DEMO_BADGE` 與 `DEMO_NOTICE` 兩個常數，兩個名字都已經不存在：
 * 前者是頁首常駐的「提案展示版」膠囊，轉正式站時整個刪除；
 * 後者更名為 `SITE_NOTICE`（刻意用改名逼出編譯期錯誤，理由見 content/site.ts）。
 *
 * 也刻意不放 `<main>` 的內距與 lz-wrap：版面完全由 LiveStage 自己控制。
 */
export default function LivePage() {
  return <LiveStage />;
}
