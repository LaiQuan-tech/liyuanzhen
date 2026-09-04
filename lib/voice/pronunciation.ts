/**
 * 送去合成之前，把會被唸錯的字換成同音字。
 *
 * 🔴 這裡改的只有「送進 ElevenLabs 的那個字串」，字幕完全不受影響——
 * 字幕走的是前端自己那份原文，跟這裡不是同一份資料。所以畫面上永遠是
 * 「婦女新知」，只有喇叭裡的那一路被動過手腳。
 *
 * ## 為什麼不用 ElevenLabs 官方的發音字典
 *
 * 1. 建字典要 `pronunciation_dictionaries_write` 權限，現在這把金鑰沒有
 *    （實測 401 `missing_permissions`），要開等於多一個人去後台點設定
 * 2. 字典的 `phoneme` 規則只支援部分英文模型，中文的四個聲調標不進 IPA，
 *    真正能用的只有 `alias`——那做的事跟這張表一模一樣
 * 3. alias 規則會變成一份存在 repo 外面的狀態。誰改了、什麼時候改的、
 *    為什麼改，都查不到。寫在這裡至少有 git log
 *
 * ## ⚠️ 加新條目之前一定要先聽過
 *
 * 同音字會破壞模型的詞彙查找：「婦女」是一個詞，「富女」不是。模型改成
 * 逐字唸之後聲調可能對了，但韻律會跟著變，不保證整體更好。所以每加一條
 * 都要拿真的句子合出來聽，不要看到同音就往表裡塞。
 *
 * 已知會被唸錯的字，靠使用者回報累積：
 *   婦 fù（四聲）→ 現在的模型唸成三聲。這個站踩得最兇，
 *      婦女新知、婦女運動、婦權會，幾乎每一段都會出現。
 */

/** `[要換掉的字串, 換成什麼]`。順序即套用順序。 */
export const PRONUNCIATION_FIXES: ReadonlyArray<readonly [string, string]> = [
  ["婦", "富"],
];

/**
 * 套用上面那張表。純函式，沒有副作用，方便測。
 *
 * ⚠️ 用 `split`/`join` 而不是正規表達式，因為表裡的字串是資料不是樣式——
 * 哪天有人加了帶正規符號的條目（例如括號），regex 版本會靜默地換錯東西。
 */
export function fixPronunciation(text: string): string {
  return PRONUNCIATION_FIXES.reduce(
    (acc, [from, to]) => acc.split(from).join(to),
    text
  );
}
