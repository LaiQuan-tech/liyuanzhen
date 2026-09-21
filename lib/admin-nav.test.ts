import { describe, it, expect } from "vitest";
import { ADMIN_NAV, isNavActive, visibleNav } from "./admin-nav";

const item = (href: string) => {
  const found = ADMIN_NAV.find((i) => i.href === href);
  if (!found) throw new Error(`導覽裡沒有 ${href}`);
  return found;
};

const events = item("/admin");
const interactions = item("/admin/interactions");
const admins = item("/admin/admins");
const logs = item("/admin/logs");
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

  // 🔴 跟上面那條同一個理由，但這兩個是後加的頁。
  // 新增導覽項目時最容易漏掉的就是回頭確認「場次」有沒有被連帶點亮。
  it("場次在後台人員／操作日誌頁不能亮", () => {
    expect(isNavActive("/admin/admins", events)).toBe(false);
    expect(isNavActive("/admin/logs", events)).toBe(false);
    expect(isNavActive("/admin/logs?entity=admin", events)).toBe(false);
  });

  it("後台人員與操作日誌各自只在自己那一頁亮", () => {
    expect(isNavActive("/admin/admins", admins)).toBe(true);
    expect(isNavActive("/admin/logs", admins)).toBe(false);
    expect(isNavActive("/admin", admins)).toBe(false);

    expect(isNavActive("/admin/logs", logs)).toBe(true);
    expect(isNavActive("/admin/admins", logs)).toBe(false);
    expect(isNavActive("/admin", logs)).toBe(false);
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
      "/admin/admins",
      "/admin/logs",
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

describe("visibleNav", () => {
  it("管理員看得到全部", () => {
    expect(visibleNav(true)).toEqual(ADMIN_NAV);
  });

  it("小編看不到後台人員與操作日誌", () => {
    const hrefs = visibleNav(false).map((i) => i.href);
    expect(hrefs).not.toContain("/admin/admins");
    expect(hrefs).not.toContain("/admin/logs");
  });

  it("小編還是看得到場次、問答紀錄與公開頁", () => {
    const hrefs = visibleNav(false).map((i) => i.href);
    expect(hrefs).toEqual(["/admin", "/admin/interactions", "/events"]);
  });

  /**
   * 🔴 managerOnly 是**顯示過濾，不是授權**。
   *
   * 這一條把那句話釘住：被過濾掉的項目仍然是 ADMIN_NAV 的一員、
   * href 仍然存在、isNavActive 仍然會對它回 true。
   * 真正擋住小編的是那兩頁第一行的 requireManager()，不是這裡。
   */
  it("被過濾掉不代表那一頁打不開——路徑仍然存在且仍然會 active", () => {
    expect(ADMIN_NAV.map((i) => i.href)).toContain("/admin/admins");
    expect(isNavActive("/admin/admins", admins)).toBe(true);
  });

  it("只有這兩頁標了 managerOnly", () => {
    expect(ADMIN_NAV.filter((i) => i.managerOnly).map((i) => i.href)).toEqual([
      "/admin/admins",
      "/admin/logs",
    ]);
  });
});
