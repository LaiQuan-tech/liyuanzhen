import type { AvatarDriver, AvatarProvider } from "./types";

/**
 * AvatarStage 在 driver 失效時的判斷。抽成純函式是為了測得到——
 * vitest 是 node 環境、沒有 jsdom，專案裡沒有 .test.tsx，元件本身完全沒有測試覆蓋。
 *
 * 🔴 2026-09-29 的決定：執行期 onFatal（token 被拒、額度用盡、SDK 載入失敗、start／attach 失敗、斷線）之後，
 * **這個 mount 內鎖定 monogram**（「李」字＋老師的克隆聲），不再重建 heygen；重新整理頁面才會再試影像。
 * - 斷線當下分不出是暫時還是持續：UNKNOWN_REASON 同時涵蓋網路斷線與 WebSocket 關閉；
 *   token 被拒（budget_exhausted／disabled／at_capacity）的話，幾分鐘內重試一定還是失敗。
 * - 每次重試都要鑄 token、可能開一個計費 session；token 鑄了之後才失敗的那一筆，帳本以 3 分鐘上限估。
 * - 舊的「下一次按就重連」從來沒真的成功過：<video> 已經隨降級卸載，下一次按撞上「沒有 video 就不開
 *   session」的護欄、那一題無聲也沒有提示；再下一次才真的去連，還會被舊 session 的孤兒計時器收掉。
 * ⚠️ 閒置／上限／切分頁的 teardown **不是**這條路：那些之後「下一次按就重連 heygen」照舊。
 */

/**
 * 下一次 ensureDriver() 要建哪一種 driver。
 * 降級過就一律 monogram，不管頁面指定了什麼（/live 指定的是 heygen）。
 * undefined ＝ 頁面沒指定，交給 createAvatarDriver 的預設（resolveProvider）。
 */
export function nextDriverProvider(
  requested: AvatarProvider | undefined,
  degraded: boolean
): AvatarProvider | undefined {
  return degraded ? "monogram" : requested;
}

/** AvatarStage 當下的狀態：卸載了沒有、driverRef 拿著誰 */
export interface StageDriverState {
  unmounted: boolean;
  current: AvatarDriver | null;
}

/**
 * stage 現在是不是還拿著這個 driver（沒卸載，而且 driverRef 就是它）。
 *
 * AvatarStage.prepare 在 `await driver.prepare(video)` 回來之後問這一句：等待期間可能發生了
 * fatal 降級、teardown（切分頁、閒置）或卸載，那時候就不可以再去開畫面、開閒置與上限計時器——
 * 開了就是孤兒計時器，到點會把之後新開的 session 收掉。
 */
export function isCurrentDriver(stage: StageDriverState, driver: AvatarDriver | null): boolean {
  return !stage.unmounted && driver !== null && stage.current === driver;
}

/**
 * 這一次 onFatal 要不要處理。卸載之後、或回報的已經不是目前這個 driver（過期）→ 忽略。
 *
 * ⚠️ 不處理過期的回報是必要的：降級會把 driverRef 換成新建的 monogram，
 * 晚一步到的舊 onFatal 如果照樣處理，會把剛換上的 monogram 當成失效的 driver 收掉。
 */
export function shouldHandleFatal(stage: StageDriverState, reporter: AvatarDriver | null): boolean {
  return isCurrentDriver(stage, reporter);
}
