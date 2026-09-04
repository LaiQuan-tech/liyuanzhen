"use client";

import type { RefObject } from "react";
import { AVATAR_NAME } from "@/content/site";
import type { AvatarState } from "@/lib/avatar/types";
import { FullBodyStage, STAGE_MASK, type Pose } from "./full-body-stage";

interface Props {
  state: AvatarState;
  /**
   * `sm` / `lg` 是圓形頭像（/chat 用）。
   * `full` 是滿版舞台（/live 用）——不做圓形裁切、不畫名牌，
   * 因為那一頁自己有一整套版面要放名字、字幕與按鈕。
   */
  size: "sm" | "lg" | "full";
  visible: boolean;
  /**
   * ⚠️ 刻意用一般 prop 傳 ref，**不要**改回 forwardRef ＋ `ref={...}`。
   *
   * 這個元件是被 next/dynamic 包起來載入的，而 dynamic() 回傳的 LoadableComponent
   * 不是 forwardRef 元件——`ref` 會被整個丟掉，videoRef.current 永遠是 null。
   * 症狀非常隱蔽：畫面照樣渲染、交叉淡入照常，但解除靜音沒生效、
   * session.attach(video) 拿到 null，所以第一次發現會是在**已經開始計費**的
   * 串流 session 上，看著一個黑框。（這個 bug 真的發生過，被 mock driver 抓到。）
   */
  videoRef: RefObject<HTMLVideoElement>;
  /**
   * 全身合成模式（只有 size="full" 會看它）。
   *
   * 開著的話影片不再滿版，而是縮到頭部大小、疊在全身底圖的頭上。
   * 底圖本身**不在這個元件裡**——它由 AvatarStage 鋪在交叉淡入的兩層底下，
   * 這樣淡入淡出時身體不會跟著一起變淡。整套的限制與對位方法寫在
   * ./full-body-stage.tsx 的檔頭，改動前先讀那份。
   *
   * ⚠️ 這裡收的是**姿勢物件不是布林**。`/live` 是坐姿、`/live2` 是站姿，
   * 兩者的影片框位置不同（她在兩張圖裡離鏡頭遠近不一樣），所以框要跟著姿勢走。
   * 遮罩不用跟——那組百分比是不變量，理由寫在 STAGE_MASK 上面。
   */
  fullBody?: Pose;
}

/**
 * 串流虛擬人的畫面。純呈現，不碰 driver、不碰 SDK——
 * 所以它可以被 next/dynamic 用 ssr:false 包起來而不牽動任何別的東西。
 *
 * ⚠️ 浮水印是常駐的，不做成可關閉。
 * 逐則回答下方的免責句只活在網頁上，但**會說話的人臉被螢幕錄影轉傳的機率
 * 遠高於文字泡泡**，而螢幕錄影不會把免責句一起帶走。所以標記必須燒在畫面裡。
 */
export default function VideoAvatar({
  state,
  size,
  visible,
  videoRef,
  fullBody,
}: Props) {
  /**
   * 滿版模式。/live 的全螢幕舞台。
   *
   * ⚠️ 浮水印在這裡比圓形頭像模式**更**必要，不是更不必要：
   * 一張佔滿螢幕、會說話的臉，正是最可能被錄下來轉傳的東西。
   * 所以這裡用的是整條橫幅而不是角標。
   */
  if (size === "full") {
    return (
      <div
        className="absolute inset-0 transition-opacity duration-700"
        style={{ opacity: visible ? 1 : 0 }}
        aria-hidden={!visible}
      >
        {fullBody ? (
          <FullBodyStage>
            <video
              ref={videoRef}
              // 跟圓形模式同一組理由，見下方註解
              muted
              playsInline
              autoPlay
              className="absolute object-cover"
              style={{
                ...fullBody.box,
                // 下緣淡出，讓串流的肩膀融進底圖的肩膀。
                // ⚠️ 兩個屬性都要寫：Safari 到現在仍然只認 -webkit- 那個，
                // 少寫的話 iOS 上會看到一條橫的硬邊。
                maskImage: STAGE_MASK,
                WebkitMaskImage: STAGE_MASK,
              }}
            />
          </FullBodyStage>
        ) : (
          <video
            ref={videoRef}
            // 跟圓形模式同一組理由，見下方註解
            muted
            playsInline
            autoPlay
            className="h-full w-full object-cover"
          />
        )}
        {/*
          ⚠️ top-16 不是隨手抓的：滿版模式的呼叫端（/live）在畫面最上方有一條
          身分列，浮水印貼在 top-3 會被那條蓋掉——實測手機版就是這樣，
          而「浮水印看不見」等於這道護欄不存在。要改上緣位置的話，
          記得同時看一眼 components/live/LiveStage.tsx 的 header 高度。

          ⚠️ 這條**刻意留在舞台框外面**（貼著視窗右緣，不是貼著全身舞台的右緣）。
          全身模式下舞台框在寬螢幕上比視窗窄，跟著框走會讓浮水印縮到畫面中央，
          離那張臉更遠也更容易被忽略。
        */}
        <span className="pointer-events-none absolute right-3 top-16 rounded-full bg-ink/80 px-3 py-1 text-[11px] font-bold tracking-wide text-white backdrop-blur-sm">
          AI 生成影像
        </span>
      </div>
    );
  }

  const dim = size === "lg" ? 128 : 56;

  return (
    <div
      className="flex flex-col items-center gap-3 transition-opacity duration-500"
      style={{ opacity: visible ? 1 : 0 }}
      aria-hidden={!visible}
    >
      <div className="relative" style={{ width: dim, height: dim }}>
        {state === "speaking" && (
          <span
            className="absolute inset-0 rounded-full border-2 border-ink/30 animate-ping"
            style={{ animationDuration: "1.4s" }}
            aria-hidden
          />
        )}

        <div
          className="relative h-full w-full overflow-hidden rounded-full border-[3px] border-ink bg-ink"
          style={{ boxShadow: "4px 5px 0 rgba(26,26,26,.18)" }}
        >
          <video
            ref={videoRef}
            // muted 先掛著：自動播放政策要求靜音才能 play()，
            // 解除靜音必須發生在使用者手勢當下（見 AvatarStage.prepare）
            muted
            playsInline // 不加的話 iOS 會強制全螢幕播放，版面直接崩掉
            autoPlay
            className="h-full w-full object-cover"
          />

          {/* 常駐標記。size=sm 時圓形太小塞不下整句，改用一個明顯的角標。 */}
          {size === "lg" ? (
            <span className="absolute bottom-0 left-0 right-0 bg-ink/75 py-1 text-center text-[10px] font-bold tracking-wide text-white">
              AI 生成影像
            </span>
          ) : (
            <span
              className="absolute bottom-0 right-0 rounded-tl-md bg-ink/85 px-1 py-[1px] text-[8px] font-bold leading-tight text-white"
              title="AI 生成影像"
            >
              AI
            </span>
          )}
        </div>
      </div>

      <div className="text-center">
        <div className="font-display text-[15px] font-bold">{AVATAR_NAME}</div>
        <div className="mt-0.5 text-[12px] text-muted">
          {state === "thinking"
            ? "正在查資料…"
            : state === "speaking"
              ? "回答中"
              : "線上・可語音朗讀"}
        </div>
      </div>
    </div>
  );
}
