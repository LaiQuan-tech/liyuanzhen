/**
 * 後台側邊欄的導覽項目。
 *
 * ⚠️ 這個檔案**不碰資料庫也不碰 React**，是純資料 ＋ 純函式，所以測得到。
 * layout（server component）與 AdminSidebar（client component）共用同一份，
 * 兩邊各寫一份遲早會不一致。
 */

export interface AdminNavItem {
  href: string;
  label: string;
  /**
   * 對外連結，要開新分頁。
   *
   * ⚠️ 這個旗標在舊版的 layout 裡宣告了但 `.map()` 從來沒讀它——
   * 兩個連結長得一模一樣，「看公開頁」是用 next/link 內部導覽把人帶出後台。
   * 現在 AdminSidebar 真的會讀它。
   */
  external?: boolean;
  /**
   * 除了 href 本身，還有哪個路徑前綴算「在這一頁」。
   *
   * 🔴 「場次」的 href 是 `/admin`，如果只用 startsWith 判斷，
   * 後台每一頁都會讓它亮起來（`/admin/interactions` 也是 `/admin` 開頭）。
   * 所以 `/admin` 只認完全相符，另外用這個欄位把 `/admin/events/*` 收進來。
   */
  alsoMatch?: string;
}

export const ADMIN_NAV: AdminNavItem[] = [
  { href: "/admin", label: "場次", alsoMatch: "/admin/events" },
  { href: "/admin/interactions", label: "問答紀錄" },
  { href: "/events", label: "看公開頁", external: true },
];

/** 這個項目是不是「現在在的那一頁」。對外連結永遠不算。 */
export function isNavActive(pathname: string, item: AdminNavItem): boolean {
  if (item.external) return false;
  if (pathname === item.href) return true;
  if (item.alsoMatch && (pathname === item.alsoMatch || pathname.startsWith(`${item.alsoMatch}/`))) {
    return true;
  }
  // href 本身的子路徑（例如 /admin/interactions/xxx）。
  // ⚠️ `/admin` 不套這一條，否則整個後台都會亮，所以先擋掉。
  if (item.href !== "/admin" && pathname.startsWith(`${item.href}/`)) return true;
  return false;
}
