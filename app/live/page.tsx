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
 * 所以 LiveStage 自己把 AVATAR_NAME、DEMO_BADGE、ANSWER_DISCLAIMER、
 * DEMO_NOTICE 全部放回畫面上。那不是可選的裝飾，見該元件的檔頭。
 *
 * 也刻意不放 `<main>` 的內距與 lz-wrap：版面完全由 LiveStage 自己控制。
 */
export default function LivePage() {
  return <LiveStage />;
}
