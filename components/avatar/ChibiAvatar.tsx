"use client";

import { useEffect, useState } from "react";
import { VISEME_ORDER, type Viseme } from "@/lib/avatar/lipsync";

/**
 * Q版數位人的分層立繪。
 *
 * ## 🔴 這是李元貞老師本人的 Q 版肖像，不再是佔位圖
 *
 * 前一版這裡畫的是一個中性幾何人形，理由是「Q 版是對在世者形象的再創作，
 * 需要授權，而那時候還沒有」。現在使用者提供了立繪，畫面上就是她。
 *
 * ⚠️ 所以這個檔案的風險等級變了。它跟 `lib/persona-prompt.ts` 一樣，
 * 是「改一行就可能讓一個未經確認的肖像出現在婦權會官網上」的那一類。
 * 在肖像使用範圍由老師本人與婦權會確認之前：
 *   1. `/chibi` 的 `robots: noindex` 不可以拿掉，也不可以進 sitemap
 *   2. 不要把這個元件掛到 `/`、`/live`、`/live2`、`/live3` 或任何訪客會走到的頁
 *   3. 頁面上「草案、待確認」的說明不可以刪
 *
 * ## 素材怎麼來的
 *
 * 使用者給的是一張 1365×768 的生成圖，做了三件事（過程與量測見 git log）：
 *
 * 1. **抹掉衣服上的字。** 原圖綠色 T 恤上有生成出來的「Gender: F」（被外套切成
 *    「Sender: [F」）。🔴 那必須拿掉——婦權會的站上，她胸口寫著 Gender: F 會被
 *    讀成一句宣言，而它只是模型把 prompt 畫到衣服上的痕跡。
 * 2. **去背。** ⚠️ 球鞋是白的，跟背景只差 1–2 階（腿間 254,249,245／鞋白
 *    254,250,247），所以不能用白色門檻。作法是從邊界 flood fill、並且跟**固定的
 *    背景參考色**比對——跟鄰居比會讓抗鋸齒的漸層變成一條走進人物內部的通道，
 *    第一次就是這樣把膚色吃掉了（人物只剩 21,916 px，正確值是 164,974）。
 *    兩腿之間與腳下影子是封閉區域，flood fill 到不了，另外用連通塊標記移除。
 * 3. **挖掉嘴、另外畫四個嘴型。**
 *
 * ## 嘴型是從原圖萃取的，不是猜的
 *
 * 第一版憑感覺畫拋物線，A/B 之後發現位置偏高、末端平切、弧度太淺。
 * 改成直接從原圖量：微笑曲線是 `y = -0.00745x² + 2.8156x + 26.28`（殘差 0.89px），
 * 線寬中央 5.0px **向兩端漸收到 1px**，最低點在 x=185 而不是正中——她的頭是微側的。
 * 四個嘴型共用這條曲線當上緣，下緣是 `depth × (1-t²)`，所以嘴角永遠閉合。
 * 重畫後 closed 與原圖的平均像素差 6.37。
 *
 * ⚠️ 下唇那個粉色小記號只出現在 closed。它在原圖裡是下唇的高光，嘴一張開就不該在，
 * 而且 mid 的下緣正好切過它，留著會變成一坨黏在嘴上的粉色髒點。
 *
 * ## 換成正式美術素材時要動什麼
 *
 * 只要換 `public/chibi/` 底下五張圖，並更新 `MOUTH_BOX` 這四個百分比。
 * props 介面不變，`LipSyncPlayer` 那一側完全不用動。
 */

/** 立繪的原始尺寸。用來鎖住外框比例，換圖時要一起更新 */
const FIGURE_ASPECT = "382 / 672";

/**
 * 嘴型圖層在立繪上的位置（相對百分比，換圖要重量）。
 * 四張嘴型圖共用同一個 bbox，所以定位只有一組。
 */
const MOUTH_BOX = {
  left: "41.099%",
  top: "41.071%",
  width: "19.895%",
  height: "7.589%",
} as const;

const MOUTH_SRC: Record<Viseme, string> = {
  closed: "/chibi/mouth-closed.webp",
  small: "/chibi/mouth-small.webp",
  mid: "/chibi/mouth-mid.webp",
  wide: "/chibi/mouth-wide.webp",
};

export interface ChibiAvatarProps {
  viseme: Viseme;
  /** 0–1 的張嘴程度。四張圖之間的微幅補間用，讓同一個嘴型也有呼吸感 */
  level: number;
  speaking: boolean;
  className?: string;
}

export default function ChibiAvatar({ viseme, level, speaking, className }: ChibiAvatarProps) {
  const [blinking, setBlinking] = useState(false);

  /**
   * 眨眼。⚠️ 目前是整張圖極短暫的垂直壓縮，不是真的閉眼——
   * 真正的閉眼需要另外兩張眼睛素材（她戴眼鏡，鏡片區的膚色跟臉頰不同，
   * 挖眼睛比挖嘴麻煩）。這是刻意的取捨：沒有任何眨眼會讓她看起來像死掉的。
   * 換到正式素材時應該改成眼睛圖層。
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          setBlinking(true);
          setTimeout(() => setBlinking(false), 110);
          schedule();
        },
        2800 + Math.random() * 2600
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  // 同一個嘴型內用 level 做極小幅度的縮放。⚠️ 幅度要小——
  // 拉太多會把線條拉變形，而分層立繪的線寬是固定的，變形一眼就看得出來。
  const mouthScale = 1 + Math.min(1, Math.max(0, level)) * 0.04;

  return (
    <div
      className={className}
      style={{ position: "relative", aspectRatio: FIGURE_ASPECT, width: "100%" }}
      role="img"
      aria-label={
        speaking ? "李元貞老師的 Q 版形象，正在說話" : "李元貞老師的 Q 版形象，待機中"
      }
    >
      <div
        className={speaking ? undefined : "chibi-breathe"}
        style={{
          position: "absolute",
          inset: 0,
          transform: blinking ? "scaleY(0.985)" : undefined,
          transformOrigin: "50% 100%",
          transition: "transform 90ms ease-out",
        }}
      >
        <img
          src="/chibi/base.webp"
          alt=""
          fetchPriority="high"
          decoding="async"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        />

        {/* 四張嘴型全部掛上去、用 opacity 切換。
            ⚠️ 不要改成只渲染當前那一張：那樣每個嘴型第一次出現時要現載，
            會在講第一句話的時候閃四次。全部掛著等於掛載時就預載完。 */}
        {VISEME_ORDER.map((v) => (
          <img
            key={v}
            src={MOUTH_SRC[v]}
            alt=""
            decoding="async"
            style={{
              position: "absolute",
              left: MOUTH_BOX.left,
              top: MOUTH_BOX.top,
              width: MOUTH_BOX.width,
              height: MOUTH_BOX.height,
              opacity: v === viseme ? 1 : 0,
              transform: v === viseme ? `scale(${mouthScale})` : undefined,
              transformOrigin: "50% 20%",
              // ⚠️ 不要加 opacity 的 transition。嘴型每 40ms 就換一次，
              // 補間會讓兩張嘴同時半透明疊著，看起來是糊的而不是順的。
              willChange: "opacity",
            }}
          />
        ))}
      </div>

      <style>{`
.chibi-breathe { animation: chibi-breathe 4.2s ease-in-out infinite; }
@keyframes chibi-breathe {
  0%, 100% { transform: translateY(0) }
  50%      { transform: translateY(-0.6%) }
}
@media (prefers-reduced-motion: reduce) {
  .chibi-breathe { animation: none; }
}
      `}</style>
    </div>
  );
}
