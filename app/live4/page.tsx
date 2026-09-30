import type { Metadata } from "next";
import LiveStage from "@/components/live/LiveStage";

/**
 * 🔴 這一頁以前有自己**獨立的** `robots: noindex`，不是靠全站那三處繼承來的。
 *
 * 理由是：全站的 noindex 擋的是「要開放收錄就三處一起改」，而那個動作會讓
 * 每一頁跟著變成可索引——但畫面上是李元貞老師的 Q 版肖像，當時使用範圍
 * 仍待老師本人與婦權會確認，所以另外加一道獨立的栓：全站開放的那一天，
 * 這一頁要被單獨拿出來討論，而不是順著一起被打開。
 *
 * 🔴 2026-09-30 專案擁有者確認：Q 版肖像已經過老師（經婦權會）確認可以使用。
 * 那道獨立的栓所擋的風險不存在了，所以拿掉了這裡的 `robots` 覆寫——這一頁
 * 現在跟全站共用同一份 robots 政策（見 `app/layout.tsx`、`app/robots.ts`；
 * 兩者現在都還是 noindex，行為今天不變，差別只在「未來全站開放收錄時，
 * 這一頁會不會自動跟著變成可索引」，答案從「不會」變成「會」，這正是理由
 * 消失之後該有的行為）。
 *
 * `/chibi` 不受影響，繼續維持自己獨立的 `robots: noindex`——理由不是授權，
 * 是它本來就是內部技術驗證頁，不對訪客開放。
 */
export const metadata: Metadata = {
  title: "虛擬互動｜李元貞 × AI 數位人",
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
 * SITE_NOTICE 放回畫面上。🔴 這一頁沒有常駐浮水印：2026-09-30 專案擁有者
 * 決定拿掉 `/live4` 原本由 `ChibiStage` 提供的「AI 生成影像」標記，AI 揭露
 * 改由頂部 AVATAR_NAME（「數位李元貞（AI 模擬）」）、每則回答下的
 * ANSWER_DISCLAIMER、底部 SITE_NOTICE 這三處負責（細節見 `ChibiStage.tsx`
 * 檔頭與原本放浮水印位置的註解）。`/live`、`/live2`、`/live3`
 * （AvatarStage／VideoAvatar 那條路，畫面是她本人的臉）的浮水印刻意保留，
 * 兩者不是同一個判斷。
 *
 * ⚠️ 這一頁現在跟全站共用同一份 `robots`（理由見上方 metadata 的註解），
 * 也已經加進 `app/sitemap.ts` 的 ROUTES——2026-09-30 專案擁有者確認 Q 版肖像
 * 使用範圍之後解除的兩道栓，理由同上方 metadata 註解。`/chibi` 是不同的
 * 判準：那一頁不對訪客開放，繼續維持自己獨立的 `robots: noindex`，也繼續
 * 不進 sitemap（見 `app/chibi/page.tsx` 檔頭）。
 */
export default function LiveChibiPage() {
  return <LiveStage variant="chibi" />;
}
