import { describe, it, expect } from "vitest";
import sitemap from "@/app/sitemap";
import { nav } from "@/content/site";

/**
 * sitemap 的內容本身很無聊，這一支存在是為了鎖住**兩個刻意的缺漏**。
 *
 * 🔴 `app/sitemap.ts` 的註解寫著「新增路由時要回來加」。那句話會讓後來的人
 * 看到少一條路由就補上去——而 `/live4` 與 `/chibi` 的缺席是刻意的：
 * 兩頁畫面上都是李元貞老師的 Q 版肖像草案，使用範圍仍待老師本人與婦權會確認。
 *
 * ⚠️ 這種「刻意的缺漏」是最容易被好意破壞的一類，因為它看起來就像遺漏。
 * 註解擋不住，測試才擋得住。
 */
describe("sitemap", () => {
  const urls = sitemap().map((entry) => entry.url);

  it("該有的路由都在", () => {
    for (const path of ["", "/live", "/live2", "/live3", "/chat", "/events", "/about-ai", "/privacy"]) {
      expect(urls.some((u) => u.endsWith(path === "" ? ".app" : path))).toBe(true);
    }
  });

  /**
   * 授權範圍確認之後才可以把 `/live4` 加進 sitemap，那時候連這條測試一起改。
   * 在那之前，這條紅燈就是提醒。
   */
  it("🔴 /live4 刻意不在 sitemap——肖像使用範圍未確認", () => {
    expect(urls.some((u) => u.includes("/live4"))).toBe(false);
  });

  it("🔴 /chibi 是內部測試頁，永遠不進 sitemap", () => {
    expect(urls.some((u) => u.includes("/chibi"))).toBe(false);
  });

  /**
   * ⚠️ 反過來也要鎖：`/live4` **在導覽列裡**（2026-09-11 由專案擁有者決定）。
   * 上面兩條看起來像「這一頁要藏起來」，但它其實是對訪客公開的，
   * 只是不希望被搜尋引擎索引。少了這一條，有人可能會為了「一致」把它從
   * 導覽列也拿掉——那會直接違背擁有者的決定。
   */
  it("⚠️ 但 /live4 是公開的：它在導覽列裡", () => {
    expect(nav.some((item) => item.href === "/live4")).toBe(true);
  });

  /**
   * 🔴 導覽列上只有兩個 live：寫實版與 Q 版。
   *
   * `/live2`（站姿）與 `/live3`（滿版）在 2026-09-11 由專案擁有者決定拿掉，
   * 但**路由還在**（`app/live2/`、`app/live3/` 都沒刪，直接輸入網址還能用）。
   * ⚠️ 這正是最容易被好意破壞的狀態：有人看到 app/ 底下有四個 live 目錄、
   * 導覽列只有兩個，會以為是漏加。這條測試就是那個「不是漏掉」的證據。
   */
  it("🔴 導覽列只有 /live 與 /live4——live2、live3 是刻意拿掉的", () => {
    const lives = nav.filter((i) => i.href.startsWith("/live")).map((i) => i.href);
    expect(lives).toEqual(["/live", "/live4"]);
  });

  /**
   * ⚠️ 反過來鎖：路由本身不可以因為「導覽列沒有」就被順手刪掉。
   * sitemap 仍列著它們，兩者要一起處理才算退役。
   */
  it("⚠️ 但 /live2 與 /live3 的路由還在（仍列在 sitemap 裡）", () => {
    expect(urls.some((u) => u.includes("/live2"))).toBe(true);
    expect(urls.some((u) => u.includes("/live3"))).toBe(true);
  });
});
