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
 *
 * ⚠️ 這裡的降級（heygen 模組載入失敗）只是**其中一條**路：立刻回傳一個能用的
 * monogram driver，聲音仍然是老師的克隆聲（monogram 也走 /api/tts，2026-09-29 起
 * 全站只剩這一種聲音）。代價是降級後每次開口一樣用 ElevenLabs 額度；它要的
 * AudioContext 由語音頁的說話按鈕解鎖（AvatarStage.prepare 帶 unmute 的那一段）。
 *
 * 🔴 另一條是**執行期**的 onFatal（token 失敗、額度用盡、斷線……），跟這支函式無關：
 * 它只在 components/avatar/AvatarStage.tsx 把畫面切成「李」字（setProvider("monogram")，
 * 純視覺狀態），driverRef 直接清成 null，不會呼叫這裡、也不會建立 monogram driver。
 * 在使用者下一次手勢重新觸發 ensureDriver()（重建的其實是 heygen，因為 providerOverride
 * 沒變）之前，那之後送進來的每一則答案完全沒有聲音——AvatarStage 的 finish() 發現
 * driverRef 是 null 就直接回報 onSpeechFailed，不會退到這裡的 monogram。
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
      // 這裡刻意**不**呼叫 hooks.onFatal：降級已經完成，使用者失去的只有那張臉
      // （聲音還是她的克隆聲），不該把它當成錯誤彈出去。留一筆 console 給我們自己看就好。
      console.error("[avatar] heygen driver 載入失敗，降級為 monogram：", error);
    }
  }

  const { createMonogramDriver } = await import("./monogram");
  return createMonogramDriver(hooks);
}
