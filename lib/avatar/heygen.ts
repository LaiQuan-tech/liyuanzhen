import type { AvatarDriver, AvatarDriverHooks } from "./types";

/**
 * Phase 2 才實作。現在是刻意留的空殼。
 *
 * 空殼不是佔位符而已——它讓 index.ts 的 dynamic import 現在就能解析
 * （webpack 對靜態字串的 `import()` 是在 build 期解析的，指向不存在的檔案會直接爆），
 * 而且讓「provider 設成 heygen 但實際上不可用 → 自動降級回 monogram」
 * 這條路徑**現在就能被測到**，不用等 SDK 裝好。
 *
 * ⚠️ 這個檔案在 Phase 2 之前不可以 import 任何 @heygen/* 的東西，
 *    包含 `import type`——套件根本還沒裝。
 */
export function createHeygenDriver(_hooks: AvatarDriverHooks): AvatarDriver {
  throw new Error(
    "heygen driver 尚未實作（Phase 2）。請改用 NEXT_PUBLIC_AVATAR_PROVIDER=mock 或 monogram。"
  );
}
