"use client";

import { AVATAR_NAME } from "@/content/site";

import type { AvatarState } from "@/lib/avatar/types";

// 型別的正本在 lib/avatar/types.ts；這裡轉出是為了讓既有的 import 路徑繼續可用
export type { AvatarState };

/**
 * 這是**備援視覺**，不是主要呈現。
 *
 * 站上的主角是串流虛擬人（`lib/avatar/heygen.ts`）：老師本人的授權影像 ＋
 * 她的克隆聲音 ＋ 即時對嘴。這個圓形「李」字標記負責的是那條路走不通的時候——
 * 串流還沒接上（prepare 之前）、連線中斷（driver 回報 onFatal 之後降級）、
 * 或 provider 本來就是 monogram（沒開 AVATAR_ENABLED、額度用完、裝置不支援）。
 *
 * ⚠️ 刻意「不」描繪老師的長相，理由**已經不是授權**（肖像授權已經簽妥），
 * 而是備援畫面用一個明確的符號比用一張靜態人臉誠實：
 * 放她的靜照在這裡，使用者會以為串流還活著、只是她剛好沒在動，
 * 於是對著一個永遠不會開口的人乾等。一個字母標記＋說話時的聲波動態，
 * 一眼就看得出「現在是文字模式」——降級要看得出來才叫降級。
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
            className="font-display font-extrabold leading-none text-white"
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
