import type { ReactNode } from "react";

/**
 * 全身舞台：底層鋪一張她站著的全身照，串流疊在上半身的位置上。
 *
 * 為什麼要這樣做：LiveAvatar **不收全身照**（上傳驗證直接退件，訊息就是
 * 「Full-body shot provided / Face is not centered」），所以串流永遠只有頭肩。
 * 但訪客要看到的是一個站著的人。這一層把兩件事拆開——
 * 上傳給 HeyGen 的是頭肩照，畫面上合成出全身。
 *
 * 🔴 代價，改動前先讀完：
 * 1. **腰部以下不會動。** 只有串流覆蓋的那一段是即時影像，再往下是靜態照片。
 *    這是這個做法的本質，不是可以調參數修掉的 bug。
 * 2. **底圖 avatar-fullbody.jpg 的下半身是 AI 生成的。** 影片框底邊（底圖
 *    y=621，大約在腹部）以上是真實攝影，以下的長褲與鞋子是模型畫出來的。
 *    她本人還在世，這件事主辦單位必須知情——浮水印（VideoAvatar 裡那條
 *    「AI 生成影像」）因此比原本更不能拿掉。
 * 3. **對位是量出來的。** 下面的數字全部相依於「現在這一隻 avatar 的串流長
 *    什麼樣」。換 avatar 就要照下面的方法重量一次。
 */

/** 底圖：她站著的全身照（9:16）。換圖一定要重算下面所有數字。 */
export const FULL_BODY_SRC = "/avatar-fullbody.jpg";

/**
 * 串流（與串流接上前的 poster）在舞台框裡的位置，單位是舞台框的百分比。
 *
 * 底圖的頭部座標是這一切的基準（1080×1920）：
 *   頭頂 y=128、下巴 y=409、頭中心 x=540 → 頭高 281、臉中心 y=268.5
 *
 * 🔴 這四個數字是**實測串流本身**量出來的，不是照上傳照片推的。
 * 第一版照「臉置中、頭高佔 45%」推，實際接上去整顆頭高了 83px——
 * HeyGen 收了照片之後會自己重新取景，上傳什麼構圖不等於串流是什麼構圖。
 *
 * 換 avatar 之後重量的方法（在 /live 的 console 跑）：
 *   const v = document.querySelector('video');
 *   const c = document.createElement('canvas');
 *   c.width = v.videoWidth; c.height = v.videoHeight;
 *   c.getContext('2d').drawImage(v, 0, 0);
 *   // 取左上角當背景色，掃出色差 > 60 的最上緣與頭部左右緣
 * 這一隻量到：1280×720、髮頂在畫面 5.28%、頭寬 338px、頭中心 x 50.78%
 * → 頭高 388px（頭高/頭寬 = 1.149，取自真實照片的 585/509）＝ 畫面的 54.0%
 * → 臉中心在畫面的 32.3%（不是 50%）
 * 再讓「頭高 = 底圖的 281」「臉中心對到底圖的 (540, 268.5)」解出這四個值。
 *
 * ⚠️ poster 與串流共用這一組是**驗過的**，不是偷懶：poster 就是 avatar 的
 * 來源照片，HeyGen 重新取景之後又把它擺回同一個位置。實測兩者在底圖
 * y=500~615 每一列的外套輪廓只差 1~2px。換 avatar 後如果這個前提不成立，
 * 要拆成兩組，否則串流接上的瞬間身體會跳。
 *
 * ⚠️ 影片框比舞台**窄**（左右邊落在底圖 x=70 與 x=996），而她的外套只到
 * x=275~801，所以那兩條垂直邊整條都壓在背景上。能這樣是因為三張圖的背景色
 * 都對齊了（見 BACKGROUND）；沒對色的話那兩條邊會變成看得見的直線。
 */
export const STAGE_BOX = {
  left: "6.47%",
  top: "5.23%",
  width: "85.73%",
  height: "27.13%",
} as const;

/**
 * 下緣羽化：影片高度的 88% 開始淡出、97% 完全消失
 * （換算回底圖 ＝ y=558 開始、y=606 淡完）。
 *
 * 🔴 這一段跟底圖 avatar-fullbody.jpg 是**一組的**，不能只改一邊。
 * 底圖的組成是：真實照片層（原始 avatar-poster.jpg 依上面的幾何縮放後貼入，
 * 底邊剛好落在 y=621 ＝ 影片框底邊）實心到 y=606，606→621 羽化，
 * 之後才是 AI 生成的下半身。所以影片必須在 y=606 之前淡完——
 * 淡出的那一段底下是同一張照片，接縫才藏得住。
 *
 * ⚠️ AI 那個身體比真實照片**窄約 7.5%**，直接接會在腰側留一道階梯。
 * 底圖裡的 AI 層已經先做過水平校正（`-resize 1161x1920! -crop 1080x1920+47+0`），
 * 校正後 y=560~615 每一列的輪廓差 1~2px。重做底圖時這一步不能漏。
 *
 * ⚠️ 起點也有下限：下巴在影片框的 59.2%。再往上就會淡到下巴，
 * 看起來像頭浮在半空中。
 */
export const STAGE_MASK =
  "linear-gradient(to bottom, #000 0%, #000 88%, transparent 97%)";

/**
 * 背景色：串流實測是 rgb(233,237,236)。
 *
 * 🔴 avatar-fullbody.jpg 與 avatar-poster-stage.jpg 的背景都已經**先在檔案裡**
 * 調成這個值。不對色的話，影片框那三條邊會在畫面上浮出一個長方形——
 * 實測差 7 個階就夠明顯了。換 avatar 後背景色若變了，兩張圖都要重調。
 * ⚠️ ImageMagick 的 `-evaluate subtract` 吃 quantum 值，寫 `7` 等於 7/65535
 * 幾乎沒動，要用百分比。
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
