import type { ReactNode } from "react";

/**
 * 全身舞台的**版面**。幾何數字與所有踩過的坑在 ./poses.ts，改對位先讀那份。
 *
 * ⚠️ 這兩個檔案拆開是有理由的，不要合回去：`poses.ts` 是純資料、沒有 JSX，
 * 所以 vitest 測得到（專案的 vitest 是 node 環境、`include` 只吃 `*.test.ts`，
 * tsconfig 又是 `jsx: "preserve"`——含 JSX 的檔案在測試裡根本解析不了）。
 * 那些百分比沒有別的東西在守，`lib/live/pose.test.ts` 是唯一的護欄。
 */

export type { Pose } from "./poses";
export {
  POSE_SEATED,
  POSE_STANDING,
  POSE_STANDING_STAGE,
  ALL_POSES,
  STAGE_MASK,
} from "./poses";

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
