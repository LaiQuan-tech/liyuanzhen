/**
 * 虛擬人的三個閘門：並發水位、月度預算、單次時長。
 *
 * ⚠️ 為什麼這三件事一定要在我們自己的程式裡，不能靠 HeyGen 的方案限制：
 *
 * 因為它的限制全部都是「壞掉」而不是「擋住」。
 *   - 並發滿了直接回錯誤，官方 OpenAPI 連並發專用的錯誤碼都沒定義（沒有 429）
 *   - credits 用完時官方明文說**進行中的 session 會被直接切斷**——
 *     正在跟她講話的人畫面當場黑掉
 *
 * 這兩種行為在一個開放給不特定大眾的網站上都不能接受。所以我們自己算，
 * 而且永遠不要讓請求打到 HeyGen 的天花板。
 */

export interface LedgerLimits {
  /**
   * 我們自己的並發上限，**必須低於方案上限**。
   * Scale 方案是 40，這裡設 36，留 4 個緩衝給「已經發出 token 但還沒建立連線」
   * 的空窗，以及我們算漏的殭屍 session。
   */
  maxConcurrent: number;
  /** 本月串流分鐘數上限。到頂就停發新 token，但不影響進行中的 session。 */
  monthlyMinuteBudget: number;
  /** 單次 session 硬上限（秒）。成本控制最有效的一根槓桿。 */
  maxSessionSeconds: number;
  /** 出事時的手動閘門 */
  enabled: boolean;
}

export interface LedgerSnapshot {
  /** 目前活著的 session 數（已扣掉逾時的殭屍） */
  activeSessions: number;
  /** 本月已消耗的串流分鐘數 */
  monthMinutesUsed: number;
}

export type AdmissionDenial =
  /** 人太多。這是唯一「等一下就會好」的拒絕，UI 要顯示排隊而不是錯誤。 */
  | "at_capacity"
  /** 本月預算用完。當月剩下的時間只剩文字問答。 */
  | "budget_exhausted"
  /** killswitch 或沒設定憑證 */
  | "disabled";

export type AdmissionResult =
  | { admit: true; maxSessionSeconds: number }
  | { admit: false; reason: AdmissionDenial; queueAhead: number };

/**
 * 純函式，沒有 IO——所以三個閘門的行為可以完全用單元測試釘住，
 * 不需要 HeyGen 帳號、不需要 Supabase、也不需要真的花錢。
 *
 * 順序有意義：killswitch 最優先，再來是預算（今天不會好），
 * 最後才是並發（等一下就會好）。把「等一下會好」的放最後，
 * 才不會在預算已經用完時還叫人去排一個永遠排不到的隊。
 */
export function decideAdmission(
  snapshot: LedgerSnapshot,
  limits: LedgerLimits
): AdmissionResult {
  if (!limits.enabled) {
    return { admit: false, reason: "disabled", queueAhead: 0 };
  }

  if (snapshot.monthMinutesUsed >= limits.monthlyMinuteBudget) {
    return { admit: false, reason: "budget_exhausted", queueAhead: 0 };
  }

  if (snapshot.activeSessions >= limits.maxConcurrent) {
    return {
      admit: false,
      reason: "at_capacity",
      // 「前面還有幾位」——這是估算不是保證，因為我們不維護真的佇列。
      // 但顯示一個具體數字比「請稍後再試」好太多。
      queueAhead: snapshot.activeSessions - limits.maxConcurrent + 1,
    };
  }

  return { admit: true, maxSessionSeconds: limits.maxSessionSeconds };
}

/**
 * 判斷一筆 session 紀錄是不是殭屍。
 *
 * ⚠️ 這是整個帳本最重要的一條規則：**永遠不要相信關閉訊號。**
 *
 * 公開網站的訪客會直接關分頁、切到別的 app、手機直接鎖屏，
 * 不會有任何人幫我們送「我結束了」。已知 HeyGen 上有大量開發者回報
 * 「明明 0 個 session 在跑卻還是報 Concurrent Limit Reached」，
 * 原因就是殭屍 session 沒清乾淨。公眾流量會把這個問題放大成常態。
 *
 * 所以判定一律用時間：超過單次上限再加一段緩衝，不管有沒有收到關閉訊號，
 * 都當它已經死了。寧可誤判成死的（最多讓並發水位低估，少賺一點），
 * 也不要誤判成活的（會把額度鎖死，最後整站沒人能用）。
 */
export function isStale(
  startedAtMs: number,
  nowMs: number,
  maxSessionSeconds: number,
  graceSeconds = 30
): boolean {
  return nowMs - startedAtMs > (maxSessionSeconds + graceSeconds) * 1000;
}

/**
 * 一筆 session 實際計費的分鐘數。
 *
 * 無條件進位：串流平台一律以分鐘為最小計費單位，講 10 秒也算 1 分鐘。
 * 帳本要跟帳單同一套算法，否則我們的預算閘門會系統性低估，
 * 等到發現時已經超支。
 */
export function billableMinutes(
  startedAtMs: number,
  endedAtMs: number,
  maxSessionSeconds: number
): number {
  const seconds = Math.max(0, (endedAtMs - startedAtMs) / 1000);
  // 殭屍 session 的 endedAt 是我們推估的，不能讓它算出天文數字
  const capped = Math.min(seconds, maxSessionSeconds);
  return Math.ceil(capped / 60);
}
