import type { ReactNode } from "react";

/**
 * 全身舞台：底層鋪一張她站著的全身照，串流的頭肩疊在頭的位置上。
 *
 * 為什麼要這樣做：LiveAvatar **不收全身照**（上傳驗證直接退件，訊息就是
 * 「Full-body shot provided / Face is not centered」），所以串流永遠只有頭肩。
 * 但訪客要看到的是一個站著的人。這一層把兩件事拆開——
 * 上傳給 HeyGen 的是頭肩照，畫面上合成出全身。
 *
 * 🔴 代價，改動前先讀完：
 * 1. **肩膀以下不會動。** 只有頭是即時影像，身體是靜態照片。她講話時真人的
 *    肩膀會微動，這裡不會，接縫附近看久了會覺得怪。這是這個做法的本質，
 *    不是可以調參數修掉的 bug。
 * 2. **底圖 avatar-fullbody.jpg 是 AI 生成的。** 胸部以下的長褲與鞋子不是
 *    照片，是模型畫出來的。她本人還在世，這件事主辦單位必須知情——
 *    浮水印（VideoAvatar 裡那條「AI 生成影像」）因此比原本更不能拿掉。
 * 3. **對位是靠數字硬對的，不是自動的。** 下面 HEAD_BOX 的四個百分比是照
 *    「串流是 16:9、臉在正中央、頭高佔畫面 45%」推出來的，而那個前提來自
 *    我們上傳的那張 avatar-poster-centered.jpg。HeyGen 如果自己重新取景，
 *    頭的大小或位置就會對不上，脖子那邊會出現接不起來的斷層。
 *    換 avatar 一定要回來重對，對法寫在 HEAD_BOX 上面。
 */

/** 底圖：她站著的全身照（9:16）。換圖一定要重算 HEAD_BOX。 */
export const FULL_BODY_SRC = "/avatar-fullbody.jpg";

/**
 * 串流影片在舞台框裡的位置與大小，單位是舞台框的百分比。
 *
 * 對位方法（換底圖或換 avatar 時照這個重算）：
 * 1. 在底圖上量出頭頂 y、下巴 y、頭部中心 x（本圖 1080×1920：128 / 409 / 540）
 *    → 頭高 281，頭部中心 y = 268
 * 2. 假設串流裡頭高佔畫面高度的 H_RATIO（本例 0.45，來自上傳照片的構圖）
 *    → 影片高 = 281 / 0.45 = 624，影片寬 = 624 × 16/9 = 1110
 * 3. 讓影片正中心對到底圖的頭部中心
 *    → left = 540 − 1110/2 = −15，top = 268 − 624/2 = −44
 * 4. 各自除以底圖的寬 1080 / 高 1920 換成百分比
 *
 * ⚠️ 影片左右與上緣**刻意超出舞台框**（負值、超過 100%），這樣三個邊都被
 * `overflow-hidden` 切掉，畫面上只剩下緣一條需要處理的接縫。改成剛好塞滿
 * 會多出三條看得見的邊。
 */
export const HEAD_BOX = {
  left: "-1.39%",
  top: "-2.28%",
  width: "102.79%",
  height: "32.52%",
} as const;

/**
 * 下緣羽化：影片高度的 78% 開始淡出，88% 完全消失。
 *
 * 🔴 這兩個數字跟底圖 avatar-fullbody.jpg 是**一組的**，不能只改一邊。
 *
 * 底圖不是單純那張 AI 全身照——它已經先把 poster（真實攝影的頭肩）
 * 合進去了，接合線就在影片高度的 88%（底圖 y=506）。挑這一列的理由是實測：
 * 那一列兩層的外套輪廓幾乎重合（左差 8px、右差 1px）。往上到 y=490 差 17/21px、
 * 往下到 y=530 差 22/9px，接在那裡會在肩膀上留一圈看得見的重影。
 *
 * 所以影片必須在 88% 之前就淡完：88% 以上底圖是純 poster 內容，影片淡出時
 * 底下是同一張臉同一件衣服，接縫看不出來；88% 以下才換成 AI 的身體。
 *
 * ⚠️ 78% 這個起點也有下限：下巴落在影片高度的 72.5%
 * （臉置中、頭高佔 45% → 50% + 22.5%）。起點往上就會淡到下巴。
 */
export const HEAD_MASK =
  "linear-gradient(to bottom, #000 0%, #000 78%, transparent 88%)";

/**
 * 9:16 的舞台框，置中。
 *
 * 🔴 `width` 的算式相依於**父層高度剛好是 100dvh**（/live 的最外層是
 * `h-[100dvh]`，AvatarStage 的容器是 `absolute inset-0`）。哪天把這一頁
 * 改成可捲動或加了頁首佔位，這個算式就會失準，舞台框會超出畫面。
 *
 * ⚠️ 用 `width: min(...)` ＋ `aspect-ratio` 而**不是** `height: 100%` ＋
 * `max-width`：後者在手機那種比 9:16 更瘦長的螢幕上，寬度被 max-width 夾住
 * 之後高度不會跟著縮，框會被壓扁成非 9:16，對位整個跑掉。
 */
export function FullBodyStage({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div
        className="relative overflow-hidden"
        style={{
          width: "min(100%, calc(100dvh * 9 / 16))",
          aspectRatio: "9 / 16",
        }}
      >
        {children}
      </div>
    </div>
  );
}
