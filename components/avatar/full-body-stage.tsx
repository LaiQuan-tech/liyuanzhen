import type { ReactNode } from "react";

/**
 * 全身舞台：底層鋪一張她站著的全身照，串流的頭疊在頭的位置上。
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
 * 2. **底圖 avatar-fullbody.jpg 的下半身是 AI 生成的。** 胸口以上是真實攝影
 *    （已經先把 avatar-poster-centered.jpg 合進去），胸口以下的長褲與鞋子
 *    是模型畫出來的。她本人還在世，這件事主辦單位必須知情——浮水印
 *    （VideoAvatar 裡那條「AI 生成影像」）因此比原本更不能拿掉。
 * 3. **對位是量出來的，不是自動的。** 下面的數字全部相依於「現在這一隻
 *    avatar 的串流長什麼樣」。換 avatar 就要照下面的方法重量一次。
 */

/** 底圖：她站著的全身照（9:16）。換圖一定要重算下面所有數字。 */
export const FULL_BODY_SRC = "/avatar-fullbody.jpg";

/**
 * 底圖上的頭部座標（1080×1920）。所有框都是從這三個數字推出來的。
 * 頭頂 y=128、下巴 y=409、頭部中心 x=540 → 頭高 281、臉中心 y=268.5
 */

/**
 * 串流影片的框（舞台框的百分比）。
 *
 * 🔴 這四個數字是**實測**串流本身量出來的，不是照上傳照片推的。
 * 一開始照「臉置中、頭高佔 45%」推，實際接上去發現整顆頭高了 83px——
 * HeyGen 收了照片之後會自己重新取景，上傳什麼構圖不等於串流是什麼構圖。
 *
 * 換 avatar 之後重量的方法（在 /live 的 console 跑）：
 *   const v = document.querySelector('video');
 *   const c = document.createElement('canvas');
 *   c.width = v.videoWidth; c.height = v.videoHeight;
 *   c.getContext('2d').drawImage(v, 0, 0);
 *   // 掃出跟左上角背景色差 > 60 的最上緣與頭部左右緣
 * 這一隻量到：1280×720、髮頂在畫面 5.28%、頭寬 338px、頭中心 x 50.78%
 * → 頭高 388px（頭高/頭寬 = 1.149，取自真實照片的 585/509）＝ 畫面的 54.0%
 * → 臉中心在畫面的 32.3%（不是 50%）
 * 再讓「頭高 = 底圖的 281」「臉中心對到底圖的 (540, 268.5)」解出下面四個值。
 *
 * ⚠️ 影片框比舞台**窄**（左右邊落在底圖 x=70 與 x=996），而她的外套只到
 * x=283~792，所以那兩條垂直邊整條都壓在背景上。能這樣是因為底圖的背景色
 * 已經對齊串流的背景色（見下方 BACKGROUND 註解）；哪天換了圖沒對色，
 * 這兩條邊會變成看得見的直線。
 */
export const VIDEO_BOX = {
  left: "6.47%",
  top: "5.23%",
  width: "85.73%",
  height: "27.13%",
} as const;

/**
 * poster（串流還沒接上時）的框。
 *
 * 🔴 跟 VIDEO_BOX **不一樣**，而且必須不一樣。
 * poster 是我們自己裁的 avatar-poster-centered.jpg——臉置中、頭高佔 45%；
 * 串流是 HeyGen 重新取景過的——臉在 32.3%、頭高佔 54%。兩張的構圖不同，
 * 要讓「頭出現在畫面上的同一個位置」，框就得各自算。
 * 兩邊共用同一組會讓串流接上的瞬間整顆頭跳一下。
 */
export const POSTER_BOX = {
  left: "-1.39%",
  top: "-2.28%",
  width: "102.79%",
  height: "32.52%",
} as const;

/**
 * 下緣羽化。兩者的百分比不同是因為兩個框的高度不同，
 * 但**換算回底圖是同一段**：y=460 開始淡、y=506 淡完。
 *
 * 🔴 y=506 這條接合線是量出來的：那一列底圖（AI 身體）與 poster 的外套輪廓
 * 左差 8px、右差 1px，幾乎重合。往上到 y=490 差 17/21px、往下到 y=530 差
 * 22/9px——接在那兩個位置都會在肩膀上留一圈看得見的重影。
 *
 * 🔴 底圖在 y=506 以上是**純 poster 內容**（真實攝影），y=506 以下才換成 AI
 * 的身體。所以影片必須在 y=506 之前淡完：淡出的那一段底下是同一張臉、
 * 同一件衣服，接縫才藏得住。
 *
 * ⚠️ 起點也有下限：下巴在影片框的 59.2%、在 poster 框的 72.5%。
 * 再往上就會淡到下巴，看起來像頭浮在半空中。
 */
export const VIDEO_MASK =
  "linear-gradient(to bottom, #000 0%, #000 69%, transparent 78%)";
export const POSTER_MASK =
  "linear-gradient(to bottom, #000 0%, #000 80%, transparent 88%)";

/**
 * 背景色：串流實測是 rgb(233,237,236)。
 *
 * 🔴 avatar-fullbody.jpg 與 avatar-poster-centered.jpg 的背景都已經**先在
 * 檔案裡**調成這個值。不對色的話，影片框那三條邊（左、右、下）會在畫面上
 * 浮出一個看得見的長方形——實測差 7 個階就夠明顯了。
 * 換 avatar 之後如果背景色變了，兩張圖都要重新調，不是只調一張。
 */

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
