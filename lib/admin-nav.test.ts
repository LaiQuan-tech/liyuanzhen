import { describe, it, expect } from "vitest";
import { ADMIN_NAV, isNavActive } from "./admin-nav";

const item = (href: string) => {
  const found = ADMIN_NAV.find((i) => i.href === href);
  if (!found) throw new Error(`導覽裡沒有 ${href}`);
  return found;
};

const events = item("/admin");
const interactions = item("/admin/interactions");
const publicSite = item("/events");

describe("isNavActive", () => {
  it("場次在 /admin 本身亮著", () => {
    expect(isNavActive("/admin", events)).toBe(true);
  });

  it("場次在自己的子頁亮著", () => {
    expect(isNavActive("/admin/events/new", events)).toBe(true);
    expect(isNavActive("/admin/events/abc-123", events)).toBe(true);
    expect(isNavActive("/admin/events/abc-123/registrations", events)).toBe(true);
  });

  // 🔴 這一條是 alsoMatch 存在的理由。
  // 天真的 startsWith("/admin") 會讓「場次」在後台每一頁都亮著，
  // 包括問答紀錄——側邊欄就永遠指著錯的地方。
  it("場次在問答紀錄頁不能亮", () => {
    expect(isNavActive("/admin/interactions", events)).toBe(false);
    expect(isNavActive("/admin/interactions?filter=failed", events)).toBe(false);
  });

  it("問答紀錄只在自己那一頁亮", () => {
    expect(isNavActive("/admin/interactions", interactions)).toBe(true);
    expect(isNavActive("/admin", interactions)).toBe(false);
    expect(isNavActive("/admin/events/new", interactions)).toBe(false);
  });

  // 對外連結會把人帶離後台，不該表現成「你在這裡」
  it("對外連結永遠不亮", () => {
    expect(isNavActive("/events", publicSite)).toBe(false);
    expect(isNavActive("/admin", publicSite)).toBe(false);
  });

  it("登入頁不讓任何項目亮", () => {
    for (const i of ADMIN_NAV) {
      expect(isNavActive("/admin/login", i)).toBe(false);
    }
  });
});

describe("ADMIN_NAV", () => {
  it("每一頁最多只有一個項目是 active", () => {
    for (const pathname of [
      "/admin",
      "/admin/events/new",
      "/admin/events/abc/registrations",
      "/admin/interactions",
      "/admin/login",
    ]) {
      const active = ADMIN_NAV.filter((i) => isNavActive(pathname, i));
      expect(active.length, `${pathname} 有 ${active.length} 個 active`).toBeLessThanOrEqual(1);
    }
  });

  it("看公開頁標成 external，才會開新分頁", () => {
    expect(publicSite.external).toBe(true);
    expect(events.external).toBeUndefined();
    expect(interactions.external).toBeUndefined();
  });
});
