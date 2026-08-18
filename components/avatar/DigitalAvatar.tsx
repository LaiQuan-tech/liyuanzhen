"use client";

import { AVATAR_NAME } from "@/content/site";

import type { AvatarState } from "@/lib/avatar/types";

// 型別的正本在 lib/avatar/types.ts；這裡轉出是為了讓既有的 import 路徑繼續可用
export type { AvatarState };

/**
 * 刻意「不」描繪李元貞老師的長相。
 *
 * 未取得肖像授權前，插畫風人像同樣是肖像，AI 生成人臉更不可行。
 * 因此用字母標記（圓形「李」字）＋ 說話時的聲波動態，
 * 清楚傳達「這是數位分身」，而不宣稱描繪本人。
 * 正式版取得授權與影像素材後，才會換成老師本人形象。
 */
export default function DigitalAvatar({
  state,
  size = "lg",
  showLabel = true,
}: {
  state: AvatarState;
  size?: "sm" | "lg";
  /**
   * 名字與狀態字要不要一起畫。
   *
   * /live 的滿版舞台自己有一整條頂部列在放名字，這裡再畫一次就會重複。
   * 預設 true，因為 /chat 與首頁都靠它。
   */
  showLabel?: boolean;
}) {
  const dim = size === "lg" ? 128 : 56;
  const fontSize = size === "lg" ? 56 : 24;

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative" style={{ width: dim, height: dim }}>
        {/* 說話時的擴散環 */}
        {state === "speaking" && (
          <>
            <span
              className="absolute inset-0 rounded-full border-2 border-ink/30 animate-ping"
              style={{ animationDuration: "1.4s" }}
              aria-hidden
            />
            <span
              className="absolute rounded-full border-2 border-ink/20 animate-ping"
              style={{ inset: -10, animationDuration: "2s" }}
              aria-hidden
            />
          </>
        )}

        <div
          className="relative flex h-full w-full items-center justify-center rounded-full border-[3px] border-ink bg-brand"
          style={{ boxShadow: "4px 5px 0 rgba(26,26,26,.18)" }}
        >
          <span
            className="font-display font-extrabold leading-none text-ink"
            style={{ fontSize }}
          >
            李
          </span>

          {/* 狀態小圓點 */}
          <span
            className="absolute rounded-full border-2 border-ink"
            style={{
              width: size === "lg" ? 22 : 13,
              height: size === "lg" ? 22 : 13,
              right: size === "lg" ? 4 : 0,
              bottom: size === "lg" ? 4 : 0,
              background: state === "idle" ? "var(--ok)" : "#fff",
            }}
            aria-hidden
          >
            {state === "thinking" && (
              <span className="absolute inset-[3px] rounded-full bg-ink animate-pulse" />
            )}
            {state === "speaking" && (
              <span className="absolute inset-0 flex items-center justify-center gap-[2px]">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-[2px] rounded-full bg-ink animate-bounce"
                    style={{
                      height: size === "lg" ? 9 : 5,
                      animationDelay: `${i * 120}ms`,
                      animationDuration: "0.7s",
                    }}
                  />
                ))}
              </span>
            )}
          </span>
        </div>
      </div>

      {showLabel && (
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
      )}
    </div>
  );
}
