/**
 * 全螢幕切換（Fullscreen API）。純函式抽出來測，DOM 呼叫留給 LiveStage.tsx 自己做。
 *
 * ⚠️ `vitest.config.ts` 是 `environment: "node"`、沒有 jsdom，這裡的函式全部改成
 * 接受注入的 document-like／element-like 物件（型別刻意寫鬆，欄位都是 `unknown`），
 * 不要在檔案頂層直接碰真正的 `document`——那樣連 import 都會在測試裡炸掉。
 * 這跟 `lib/avatar/monogram.ts` 的 `ClonedVoiceEnv` 是同一套作法。
 *
 * 🔴 iPhone Safari 不支援對一般元素全螢幕：`document.fullscreenEnabled` 是 false，
 * 或者整組 API（`requestFullscreen`／`webkitRequestFullscreen`）根本不存在——
 * 兩種情況這個檔案都要能抓到，理由見 `isFullscreenSupported`。
 */

/** `isFullscreenSupported` 需要看的那幾樣東西。 */
export interface FullscreenSupportEnv {
  /** 明確是 `false` 才代表「這台裝置不給用」，見下方函式註解。 */
  fullscreenEnabled?: unknown;
  documentElement?:
    | {
        requestFullscreen?: unknown;
        webkitRequestFullscreen?: unknown;
      }
    | null;
}

/**
 * 這個瀏覽器能不能對一般元素全螢幕。
 *
 * 🔴 iPhone Safari 有兩種長法都要擋，缺一個就會出現一顆按了沒反應的按鈕：
 * 一種是 `requestFullscreen`／`webkitRequestFullscreen` 兩個方法都不存在；
 * 另一種是方法存在，但 `document.fullscreenEnabled` 明講「這台裝置不給用」。
 *
 * ⚠️ 只擋明確的 `false`。沒有 `fullscreenEnabled` 這個欄位的很舊的純 webkit
 * 瀏覽器當作沒意見，不要因為讀不到一個較新的屬性就誤判成不支援。
 */
export function isFullscreenSupported(doc: FullscreenSupportEnv | undefined): boolean {
  const el = doc?.documentElement;
  if (!el) return false;
  const hasRequest =
    typeof el.requestFullscreen === "function" || typeof el.webkitRequestFullscreen === "function";
  if (!hasRequest) return false;
  if (doc?.fullscreenEnabled === false) return false;
  return true;
}

/** `isDocumentFullscreen` 需要看的那幾樣東西。 */
export interface FullscreenStateEnv {
  fullscreenElement?: unknown;
  webkitFullscreenElement?: unknown;
}

/**
 * 目前是不是全螢幕。
 *
 * ⚠️ 標準屬性優先，webkit 後備接在 `??` 後面——舊版 Safari 只認 webkit 前綴那一套，
 * 判斷依據就是題目給的那一句：`document.fullscreenElement ?? webkitFullscreenElement`。
 */
export function isDocumentFullscreen(doc: FullscreenStateEnv | undefined): boolean {
  if (!doc) return false;
  return Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement);
}

/** `requestFullscreenOn` 需要看的那幾樣東西。 */
export interface FullscreenElementEnv {
  requestFullscreen?: unknown;
  webkitRequestFullscreen?: unknown;
}

/**
 * 進入全螢幕。標準 API 優先（帶 `navigationUI: "hide"`——連網址列都不留），
 * Safari 舊版退到 webkit 前綴。
 *
 * ⚠️ 一定要吞掉 reject：不在使用者手勢裡呼叫、或被瀏覽器政策擋下來時
 * `requestFullscreen()` 會 reject，這裡絕不能讓錯誤冒出去影響頁面。
 */
export async function requestFullscreenOn(el: FullscreenElementEnv | undefined): Promise<void> {
  if (!el) return;
  try {
    if (typeof el.requestFullscreen === "function") {
      await (el.requestFullscreen as (options?: { navigationUI?: "hide" }) => Promise<void>)({
        navigationUI: "hide",
      });
    } else if (typeof el.webkitRequestFullscreen === "function") {
      await (el.webkitRequestFullscreen as () => Promise<void> | void)();
    }
  } catch {
    // 吞掉：可能是不在使用者手勢裡呼叫，也可能是瀏覽器政策擋下來，
    // 兩種都不該讓錯誤冒出去影響頁面（呼叫端不用再包一層 try/catch）。
  }
}

/** `exitFullscreenOn` 需要看的那幾樣東西。 */
export interface FullscreenExitEnv {
  exitFullscreen?: unknown;
  webkitExitFullscreen?: unknown;
}

/**
 * 離開全螢幕。標準 API 優先，Safari 舊版退到 webkit 前綴。
 *
 * ⚠️ 同樣要吞掉 reject，理由跟 `requestFullscreenOn` 一樣。
 */
export async function exitFullscreenOn(doc: FullscreenExitEnv | undefined): Promise<void> {
  if (!doc) return;
  try {
    if (typeof doc.exitFullscreen === "function") {
      await (doc.exitFullscreen as () => Promise<void>)();
    } else if (typeof doc.webkitExitFullscreen === "function") {
      await (doc.webkitExitFullscreen as () => Promise<void> | void)();
    }
  } catch {
    // 同上。
  }
}

/**
 * 切換式按鈕該做的事：目前是全螢幕就離開，不是就進入。
 *
 * 判斷「目前是不是全螢幕」跟「離開時查得到的欄位」刻意共用同一個 `doc` 參數
 * ——呼叫端（LiveStage.tsx）直接整個 `document` 傳進來就好，不用自己先拆判斷。
 */
export async function toggleFullscreen(
  el: FullscreenElementEnv | undefined,
  doc: (FullscreenExitEnv & FullscreenStateEnv) | undefined
): Promise<void> {
  if (isDocumentFullscreen(doc)) {
    await exitFullscreenOn(doc);
  } else {
    await requestFullscreenOn(el);
  }
}

/**
 * 全螢幕按鈕文字。
 *
 * 🔴 先放在這裡當常數，不要改 `content/site.ts`——另一個代理正在改那個檔案，
 * 同時改會互相蓋掉彼此的版本。之後可以搬進 `content/site.ts` 的 `liveCopy`，
 * 跟其他語音頁文案放在一起，就不會散在兩個檔案。
 */
export const FULLSCREEN_ENTER_LABEL = "全螢幕";
export const FULLSCREEN_EXIT_LABEL = "離開全螢幕";

/** 依目前是不是全螢幕，決定按鈕該顯示哪一句。 */
export function fullscreenButtonLabel(isFullscreen: boolean): string {
  return isFullscreen ? FULLSCREEN_EXIT_LABEL : FULLSCREEN_ENTER_LABEL;
}
