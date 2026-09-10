import type { Metadata } from "next";
import LiveStage from "@/components/live/LiveStage";

/**
 * 🔴 `robots` 是這一頁**自己**的，不是靠全站那三處繼承來的。
 *
 * 全站現在確實整站 noindex（`app/layout.tsx` 的 metadata.robots ＋ 手寫 meta，
 * 加上 `app/robots.ts` 的 disallow），所以這一行今天不改變任何行為。
 * 它擋的是未來：那三處的註解寫著「要開放收錄就三處一起改」，而那個動作
 * 會讓這一頁跟著變成可索引——畫面上是李元貞老師的 Q 版肖像**草案**，
 * 使用範圍仍待老師本人與婦權會確認。
 *
 * 也就是說這是一道獨立的栓：全站開放的那一天，這一頁要被單獨拿出來討論，
 * 而不是順著一起被打開。`/chibi` 用的是同一個判準。
 */
export const metadata: Metadata = {
  title: "虛擬互動（Q 版）｜李元貞 × AI 數位人",
  robots: { index: false, follow: false },
};

/**
 * `/live` 的第四個版本：同樣是滿版的語音互動，但畫面上的人是 **Q 版分層立繪**，
 * 不是 HeyGen 的串流虛擬人。
 *
 * 跟前三頁的差別，四件事：
 *
 * 1. 🔴 **不用 HeyGen，所以不按 session 計費。** `/live`、`/live2`、`/live3`
 *    各自一掛載就開一條計費中的串流（三個分頁同時開著就是三份錢）。這一頁
 *    唯一會花錢的是 `/api/tts`——跟另外三頁**同一支端點、同一筆額度**，
 *    也就是「她開口講話」那一段成本三頁都一樣，差別是這裡沒有另外那條
 *    按分鐘算的串流。
 * 2. **不需要臉部對位。** 前三頁要把即時串流的臉貼進全身底圖的頭部位置，
 *    髮頂到脖子、影片框四個百分比、橢圓遮罩烘焙值全部是量出來的，
 *    `components/avatar/poses.ts` 還記著站姿那張當初量錯過一次。Q 版的嘴型
 *    是畫在立繪自己身上的圖層，沒有兩個影像要對齊。
 * 3. **背景是 CSS 漸層，不是圖檔。** 🔴 不要改成照片式背景：`/live3` 的檔頭
 *    記著整段教訓（四輪修圖、亮度量測），平塗的人物放進有方向性自然光的
 *    真實場景，不match在人物**內部**，去背怎麼修都到不了。這一頁的人物是
 *    卡通線稿，比那張全身圖更平，配照片只會更糟。
 * 4. **對嘴是自己算的。** `/api/tts` 的裸 PCM 一邊播、一邊由
 *    `lib/avatar/lipsync-player.ts` 算出嘴型時間軸。這條線的技術驗證頁是
 *    `/chibi`（還留著，那裡量得到首字延遲）。
 *
 * 其餘全部跟前三頁共用同一個 `LiveStage`：錄音、STT、RAG、字幕、免責、
 * 揭露、限流、錯誤文案、TracePanel 一行都沒有分岔。
 *
 * 頁面本身一樣是一層薄殼，同樣**刻意不掛** `<Nav />` 與 `<Footer />`——
 * 這一頁的重點就是那個佔滿螢幕的人，上下各一條列會把它切碎。代價是頁首頁尾
 * 常駐的揭露不會跟過來，所以 `LiveStage` 自己把 AVATAR_NAME、ANSWER_DISCLAIMER、
 * SITE_NOTICE 放回畫面上，而畫面上的常駐浮水印由 `ChibiStage` 提供
 * （HeyGen 那條路是 AvatarStage／VideoAvatar 提供的，換掉 avatar 元件不等於
 * 那道揭露可以跟著消失）。那不是可選的裝飾。
 *
 * ⚠️ 這一頁有**自己的** `robots: noindex`，理由見 metadata 上方的註解。
 * ⚠️ 也刻意**不**加進 `app/sitemap.ts`。畫面上是李元貞老師的 Q 版肖像草案，
 * 使用範圍仍待老師本人與婦權會確認（見 `components/avatar/ChibiAvatar.tsx`
 * 的檔頭），不希望被索引的頁面不該出現在 sitemap 裡——`/chibi` 是同樣的判準。
 */
export default function LiveChibiPage() {
  return <LiveStage variant="chibi" />;
}
