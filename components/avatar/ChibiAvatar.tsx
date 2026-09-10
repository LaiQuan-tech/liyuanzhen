"use client";

import { useEffect, useState } from "react";

import type { Viseme } from "@/lib/avatar/lipsync";

/**
 * 對嘴的**技術鷹架**，不是人物設計。
 *
 * 🔴 這裡畫的是一個中性的幾何人形——圓頭、兩顆點眼睛、一張會變形的嘴。
 * 它**刻意不像任何真人**，尤其不可以像李元貞老師：她是在世者，Q 版是對真人
 * 形象的**再創作**，需要她本人與婦權會的授權，而這一版還沒有。所以這支檔案
 * 存在的唯一理由是「證明嘴會跟著聲音動」，不是「這個角色長怎樣」。
 *
 * ⚠️ 改這個檔的時候不要「順手畫得像一點」。加眼鏡、加髮型、加任何她的特徵，
 * 都會讓一個未授權的肖像跟著部署上正式站。要換人物就是等美術素材發包回來。
 *
 * ## 正式版會怎麼換
 *
 * 上線時這裡的 inline SVG 會整個換成**分層立繪**：一張底圖（身體、頭髮、眼睛）
 * 疊上四張嘴型圖，依 `viseme` 切換哪一張顯示。
 *
 * 🔴 **props 介面保持不變**（`viseme` / `level` / `speaking` / `className`）。
 * 換素材是換這支檔案的內部，不該動到 `app/chibi/page.tsx` 或
 * `lib/avatar/lipsync-player.ts` 任何一行——那條界線是這一版最值得留下來的東西。
 *
 * ⚠️ 這支**完全不碰音訊**。它不知道 `AudioContext` 存在，只吃 props。
 * 對嘴會不會準完全由 `LipSyncPlayer.currentViseme()` 決定，跟這裡無關；
 * 要 debug 對不對齊請去看那支，不要在這裡加時間邏輯。
 */

/** 嘴的幾何。畫成一顆單位橢圓再縮放，closed 就是壓扁成一條線。 */
interface MouthShape {
  /** 水平縮放（user unit） */
  sx: number;
  /** 垂直縮放（user unit） */
  sy: number;
}

/**
 * 四個嘴型各一組縮放值。
 *
 * ⚠️ 型別是 `Record<Viseme, …>`——`lipsync.ts` 哪天多一個嘴型，這裡會編譯失敗，
 * 而不是安靜地少畫一張。那支檔頭寫了「不要加到八個」的理由，但萬一加了，
 * 要在 build 就知道。
 */
const MOUTH: Record<Viseme, MouthShape> = {
  closed: { sx: 13, sy: 1.6 },
  small: { sx: 9, sy: 5 },
  mid: { sx: 11, sy: 9.5 },
  wide: { sx: 12.5, sy: 14 },
};

/** 眨眼一次多久（毫秒）。人的一次眨眼約 100–150ms */
const BLINK_MS = 120;
const BLINK_GAP_MIN_MS = 3_000;
const BLINK_GAP_MAX_MS = 5_000;

export interface ChibiAvatarProps {
  viseme: Viseme;
  /** 0–1 的張嘴程度。在該嘴型的基準值上再微調，讓同一個嘴型也有輕重之分 */
  level: number;
  /** 有沒有在講話。只影響待機呼吸與無障礙標籤，不影響嘴型 */
  speaking: boolean;
  className?: string;
}

export default function ChibiAvatar({ viseme, level, speaking, className }: ChibiAvatarProps) {
  const [blinking, setBlinking] = useState(false);

  /**
   * 隨機眨眼。
   *
   * ⚠️ 隨機數只能在 effect 裡（＝只在瀏覽器），不能在 render 期間算——
   * SSR 與 client 各擲一次骰子會造成 hydration mismatch。
   */
  useEffect(() => {
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let openTimer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      const gap = BLINK_GAP_MIN_MS + Math.random() * (BLINK_GAP_MAX_MS - BLINK_GAP_MIN_MS);
      closeTimer = setTimeout(() => {
        setBlinking(true);
        openTimer = setTimeout(() => {
          setBlinking(false);
          schedule();
        }, BLINK_MS);
      }, gap);
    };

    schedule();
    return () => {
      if (closeTimer) clearTimeout(closeTimer);
      if (openTimer) clearTimeout(openTimer);
    };
  }, []);

  const shape = MOUTH[viseme];
  // level 只在該嘴型的基準值附近微調（±10%），不跨階——跨階是 lipsync.ts 的職責
  const openness = 0.9 + 0.2 * Math.min(1, Math.max(0, level));
  const sy = shape.sy * (viseme === "closed" ? 1 : openness);
  const eyeScaleY = blinking ? 0.1 : 1;

  return (
    <div className={className}>
      <style>{CHIBI_CSS}</style>
      <svg
        viewBox="0 0 200 250"
        role="img"
        aria-label={
          speaking
            ? "示意用的佔位角色，正在做對嘴動作"
            : "示意用的佔位角色，待機中"
        }
        className="chibi-svg"
      >
        <title>對嘴技術驗證用的佔位角色（示意圖，非人物設計）</title>

        {/* 虛線框與角標：讓它一眼就是「示意圖」而不是「一個角色」 */}
        <rect
          x="4"
          y="4"
          width="192"
          height="242"
          rx="14"
          fill="none"
          stroke="var(--line)"
          strokeWidth="1.5"
          strokeDasharray="7 7"
        />
        <text
          x="100"
          y="26"
          textAnchor="middle"
          fontSize="10"
          letterSpacing="1.6"
          fill="var(--gray)"
          fontWeight="700"
        >
          PLACEHOLDER・示意
        </text>

        {/* 呼吸：待機時整個人上下浮 2px。講話時停掉，免得跟嘴型互相干擾 */}
        <g className={speaking ? undefined : "chibi-breathe"}>
          {/* 身體：一個沒有任何服裝細節的圓角柱 */}
          <path
            d="M58 246 V200 a42 42 0 0 1 84 0 V246 Z"
            fill="var(--brand-soft)"
            stroke="var(--ink)"
            strokeWidth="3"
            strokeLinejoin="round"
          />
          {/* 脖子 */}
          <rect
            x="91"
            y="132"
            width="18"
            height="28"
            rx="6"
            fill="var(--brand-soft)"
            stroke="var(--ink)"
            strokeWidth="3"
          />
          {/* 頭：一個圓。沒有髮型、沒有耳朵、沒有鼻子 */}
          <circle cx="100" cy="92" r="52" fill="var(--brand-wash)" stroke="var(--ink)" strokeWidth="3" />

          {/* 眼睛：兩顆點。眨眼是把它壓扁，不是換圖 */}
          <g className="chibi-eye" transform={`translate(78 84) scale(1 ${eyeScaleY})`}>
            <ellipse cx="0" cy="0" rx="6.5" ry="8.5" fill="var(--ink)" />
          </g>
          <g className="chibi-eye" transform={`translate(122 84) scale(1 ${eyeScaleY})`}>
            <ellipse cx="0" cy="0" rx="6.5" ry="8.5" fill="var(--ink)" />
          </g>

          {/*
            嘴：一顆單位橢圓 ＋ 縮放。
            ⚠️ 用縮放而不是四條 path，是為了讓瀏覽器可以在兩個嘴型之間補間——
            分析器每 40ms 才給一幀，硬切會有階梯感。60ms 的過渡剛好把階梯磨掉，
            又短到不會讓嘴慢半拍。
          */}
          <g className="chibi-mouth" transform={`translate(100 118) scale(${shape.sx} ${sy})`}>
            <ellipse cx="0" cy="0" rx="1" ry="1" fill="var(--ink)" />
          </g>
        </g>
      </svg>
    </div>
  );
}

const CHIBI_CSS = `
.chibi-svg { display: block; width: 100%; height: auto; }
.chibi-mouth { transition: transform 60ms linear; }
.chibi-eye { transition: transform 60ms linear; }
.chibi-breathe { animation: chibi-breathe 4s ease-in-out infinite; }
@keyframes chibi-breathe {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(2px); }
}
@media (prefers-reduced-motion: reduce) {
  .chibi-breathe { animation: none; }
  .chibi-mouth, .chibi-eye { transition: none; }
}
`;
