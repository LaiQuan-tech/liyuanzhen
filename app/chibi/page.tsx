import type { Metadata } from "next";

import ChibiLab from "./ChibiLab";

/**
 * 🔴 這一頁必須 noindex，而且理由跟全站那三處不同。
 *
 * 全站的 noindex（`app/robots.ts`、`app/layout.tsx` 的 metadata.robots 與手寫 meta）
 * 擋的是「肖像授權不等於搜尋引擎授權」。這一頁多一層：畫面上那個角色是
 * **佔位圖**，它一旦被收錄，搜尋結果會把一個未經授權、也不是最終設計的
 * Q 版人形跟老師的名字綁在一起——而搜尋結果頁不會顯示「這是示意圖」。
 *
 * ⚠️ 所以就算哪天全站開放收錄，這一頁的 robots 也要單獨留著。
 * 它是頁面層級的設定，不會被上層覆蓋。
 *
 * ⚠️ 也刻意**不**加進 `app/sitemap.ts` 的 ROUTES。那份清單的註解寫著「新增路由時
 * 要回來加」，這一頁是明確的例外：不希望被索引的頁面不該出現在 sitemap 裡。
 */
export const metadata: Metadata = {
  title: "對嘴技術驗證（非人物設計）｜內部測試頁",
  robots: { index: false, follow: false },
};

/**
 * Q 版數位人「對嘴」的技術驗證頁。
 *
 * ## 這一頁要證明什麼
 *
 * 現況是寫實數位人（HeyGen LiveAvatar）：**按 session 計費**，而且臉部對位複雜到
 * `components/avatar/poses.ts` 得記著「站姿那張當初量錯過一次」。想換成 Q 版分層
 * 立繪自己做對嘴，在發包美術素材之前要先確定兩件事：
 *
 * 1. 對嘴這條線在瀏覽器裡跑不跑得起來（`lib/avatar/lipsync-player.ts`）
 * 2. 首字延遲是多少（畫面上那個毫秒數）
 *
 * 美術素材之後才發包，所以這一版是**零美術成本**：角色是程式畫的幾何人形。
 *
 * ## ⚠️ 這一頁不碰現有管線
 *
 * `/live`、`/live2`、`/live3` 與它們共用的 `LiveStage`／`poses.ts` 完全沒有動。
 * 這是刻意的：那條線是活的、在計費的、而且對位參數是量出來的。
 * 這一頁只讀 `/api/tts`（跟 `/live` 同一支端點），不共用任何元件。
 *
 * 🔴 右邊那顆按鈕**會花錢**（ElevenLabs 額度），跟 `/live` 開一個 session 一樣。
 * 左邊那顆完全在瀏覽器裡合成測試音，不呼叫任何 API。
 */
export default function ChibiPage() {
  return (
    <main className="lz-wrap-wide py-10 md:py-14">
      <span className="lz-eyebrow">內部技術驗證</span>

      <h1 className="lz-h2 mt-4">對嘴技術驗證，非人物設計</h1>

      <p className="lz-lead mt-4">
        這一頁在測「PCM 串流能不能一邊播、一邊算出嘴型時間軸」，以及第一個音訊要多久才
        排得進喇叭。畫面上的角色是<strong>程式畫的佔位幾何人形</strong>，
        不是最終的 Q 版設計，也刻意不描繪任何真人。
      </p>

      <div className="lz-card-wash mt-6 p-4 text-sm leading-relaxed md:p-5">
        <p>
          <strong>關於畫面上這個角色：</strong>
          它是對嘴的技術鷹架，不是人物設計。Q 版是對真人形象的再創作，需要李元貞老師本人
          與婦權會的授權，而這一版還沒有——所以這裡畫的是一個中性的、明顯是示意圖的
          幾何人形。正式版會把它換成分層立繪（每個嘴型一張圖），元件的 props 介面不變。
        </p>
        <p className="mt-3">
          <strong>關於花費：</strong>
          「本機測試音」完全在瀏覽器裡合成，不呼叫任何 API，免費。
          「真的合成一句」會打 /api/tts，用掉 ElevenLabs 額度。
        </p>
      </div>

      <div className="mt-8">
        <ChibiLab />
      </div>

      <p className="mt-10 text-xs text-muted">
        這一頁不會被搜尋引擎索引，也不在 sitemap 裡。它會跟著正式站一起部署，但不是給
        訪客看的內容。
      </p>
    </main>
  );
}
