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
 * 🔴 另一條是**執行期**的 onFatal（token 被拒、額度用盡、SDK 載入失敗、start／attach 失敗、斷線），
 * 由 components/avatar/AvatarStage.tsx 處理（2026-09-29 起）：畫面切成「李」字，並立刻經這支函式
 * 建一個 monogram driver 接手（降級旗標讓它無視頁面指定的 heygen，見 lib/avatar/fallback.ts）。
 * 那之後**同一個 mount 內一律是 monogram**：不再重建 heygen、不再打 /api/avatar-token，
 * 重新整理頁面才會再試影像。
 * - heygen 自己收下卻還沒講完的那一則（排隊中、合成中、講到一半），它在報 onFatal 之前會先報
 *   onSpeechFailed（見 types.ts 的 onFatal 契約）；降級之後不補說那一則。
 * - monogram 的 AudioContext 只能在手勢裡解鎖，所以降級之後、下一次按說話之前到的答案放不出聲音，
 *   由 monogram 自己回報 onSpeechFailed（刻意不在手勢外開 AudioContext，理由見 AvatarStage 的 onFatal）。
 * ⚠️ 以前（到 2026-09-29 為止）這條路只切畫面、driverRef 清成 null、不建 driver：之後的答案全部沒聲音，
 * 下一次按重建的又是 heygen、卡在「沒有 <video> 就不開 session」的護欄，那一題連提示都沒有。
 * ⚠️ 所以建計費 driver 時會先預載 monogram 模組，見 preloadMonogram。
 */
export async function createAvatarDriver(
  hooks: AvatarDriverHooks,
  provider: AvatarProvider = resolveProvider()
): Promise<AvatarDriver> {
  if (provider === "mock") {
    const { createMockDriver } = await import("./mock");
    preloadMonogram();
    return createMockDriver(hooks);
  }

  if (provider === "heygen") {
    try {
      const { createHeygenDriver } = await import("./heygen");
      preloadMonogram();
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

/**
 * 先把 monogram 模組載好（只載模組：不建 driver、不碰 AudioContext、不打 /api/tts）。
 * 只在建計費 driver（heygen、mock）時呼叫；/chat 本來就是 monogram，不需要。
 *
 * 🔴 為什麼（2026-09-29）：計費 driver 在執行期 onFatal 之後，AvatarStage 會立刻經 createAvatarDriver
 * 建一個 monogram 接手，而 monogram 在語音頁是懶載入的 chunk。斷線最常見的成因就是網路不穩，
 * 那時候這個 chunk 也載得慢——訪客在它載完之前按下說話，driverRef 還是 null，
 * 手勢裡的 unlockAudio 落空，那一題就沒有聲音。
 *
 * 在建計費 driver 的當下（網路正常的時候）先載好，就足夠了：
 * webpack 的 `__webpack_require__.e` 對已經裝好的 chunk 什麼都不送（installedChunks 是 0 就不推任何 promise，
 * `Promise.all([])`），`import("./monogram")` 只剩幾個 microtask 就 resolve；onFatal 之後
 * createAvatarDriver → ensureDriver 把 monogram 放進 driverRef 的整段都在**同一個 task 的 microtask** 裡跑完。
 * 按說話的 click 是之後的另一個 macrotask，插不進去，所以按下去時 driverRef 一定已經是 monogram。
 * （預載還沒完就斷線的話，onFatal 的 import 會共用同一個還在飛的 chunk 請求，不會重新開始。）
 *
 * ⚠️ 失敗一定要接住：預載只是加速，載不到就等 onFatal 那時再載一次（跟沒有預載時一樣），
 * 不可以變成 unhandled rejection，也不可以影響這一次回傳的 driver。
 */
function preloadMonogram(): void {
  void import("./monogram").catch(() => {});
}
