import type { AvatarDriver, AvatarDriverHooks, AvatarProvider } from "./types";

export type {
  AvatarDriver,
  AvatarDriverHooks,
  AvatarProvider,
  AvatarState,
} from "./types";
export { deriveAvatarState, speakableAnswer } from "./types";

/**
 * 與檢索層（lib/retrieval/index.ts）不同，這裡**不能靠憑證自動偵測**——
 * HEYGEN_API_KEY 絕不能讓瀏覽器看到，所以前端只看得到一個旗標。
 *
 * 這代表旗標有可能跟現實不一致（旗標寫 heygen，但伺服器根本沒 key）。
 * 那種不一致由 createAvatarDriver 的降級與執行期的 onFatal 接住，不在這裡處理。
 */
export function resolveProvider(
  raw = process.env.NEXT_PUBLIC_AVATAR_PROVIDER
): AvatarProvider {
  if (raw === "heygen" || raw === "mock") return raw;
  return "monogram";
}

/**
 * 一律 dynamic import：讓 heygen 那條路（連同它將來會帶進來的 livekit / webrtc-adapter）
 * 完全不進入預設 bundle，也不會在 SSR 期間被求值。
 *
 * 永遠會回傳一個可用的 driver。載入失敗不丟例外，直接降級成 monogram——
 * 數位人做不出來的時候，網站要退化成「還能用的文字聊天」，而不是白畫面。
 */
export async function createAvatarDriver(
  hooks: AvatarDriverHooks,
  provider: AvatarProvider = resolveProvider()
): Promise<AvatarDriver> {
  if (provider === "mock") {
    const { createMockDriver } = await import("./mock");
    return createMockDriver(hooks);
  }

  if (provider === "heygen") {
    try {
      const { createHeygenDriver } = await import("./heygen");
      return createHeygenDriver(hooks);
    } catch (error) {
      // 這裡刻意**不**呼叫 hooks.onFatal：降級已經完成，使用者什麼都沒失去，
      // 不該把它當成錯誤彈出去。留一筆 console 給我們自己看就好。
      console.error("[avatar] heygen driver 載入失敗，降級為 monogram：", error);
    }
  }

  const { createMonogramDriver } = await import("./monogram");
  return createMonogramDriver(hooks);
}
