import { describe, it, expect } from "vitest";
import sitemap from "@/app/sitemap";
import { nav } from "@/content/site";

/**
 * sitemap 的內容本身很無聊，這一支存在是為了鎖住一個**刻意的缺漏**，
 * 並且記錄 `/live4` 那個缺漏後來怎麼解除的。
 *
 * 🔴 `app/sitemap.ts` 的註解寫著「新增路由時要回來加」。那句話會讓後來的人
 * 看到少一條路由就補上去——而 `/chibi` 的缺席是刻意的：它是內部技術驗證頁，
 * 不是給訪客看的內容。
 *
 * ⚠️ 這種「刻意的缺漏」是最容易被好意破壞的一類，因為它看起來就像遺漏。
 * 註解擋不住，測試才擋得住。
 *
 * `/live4` 以前是同一類缺漏（畫面上的 Q 版肖像使用範圍當時還待老師本人與
 * 婦權會確認），2026-09-30 專案擁有者確認已經過老師（經婦權會）確認可以使用，
 * 所以現在**反過來**鎖住它一定要在 sitemap 裡——見下面那條測試。
 */
describe("sitemap", () => {
  const urls = sitemap().map((entry) => entry.url);

  it("該有的路由都在", () => {
    for (const path of ["", "/live", "/live2", "/live3", "/live4", "/chat", "/events", "/about-ai", "/privacy"]) {
      expect(urls.some((u) => u.endsWith(path === "" ? ".app" : path))).toBe(true);
    }
  });

  /**
   * 🔴 2026-09-30：專案擁有者確認 Q 版肖像已經過老師（經婦權會）確認可以使用，
   * `/live4` 不再是「使用範圍未確認」的例外，這條測試從「鎖住缺席」改成
   * 「鎖住在場」——回頭把它拿掉是退步，不是簡化。
   */
  it("🔴 /live4 在 sitemap 裡——肖像使用範圍已於 2026-09-30 確認", () => {
    expect(urls.some((u) => u.includes("/live4"))).toBe(true);
  });

  it("🔴 /chibi 是內部測試頁，永遠不進 sitemap", () => {
    expect(urls.some((u) => u.includes("/chibi"))).toBe(false);
  });

  /**
   * ⚠️ `/live4` 同時要在導覽列裡（2026-09-11 由專案擁有者決定掛進去）。
   * 少了這一條，有人可能會為了「跟 /chibi 一致」把它從導覽列也拿掉——
   * 但 `/live4` 一直都是對訪客公開的頁面，只是曾經不希望被搜尋引擎索引。
   */
  it("⚠️ /live4 也在導覽列裡", () => {
    expect(nav.some((item) => item.href === "/live4")).toBe(true);
  });

  /**
   * 🔴 導覽列上只剩一個 live：`/live4`。
   *
   * `/live2`（站姿）與 `/live3`（滿版）在 2026-09-11 由專案擁有者決定拿掉；
   * `/live`（寫實版）在 2026-09-29 由專案擁有者再決定拿掉，原話是「選單中，
   * 虛擬互動的選項移除，虛擬互動（Q 版）改成虛擬互動」——網站上的「虛擬互動」
   * 從此只代表 `/live4`。三個路由**都還在**（`app/live/`、`app/live2/`、
   * `app/live3/` 都沒刪，直接輸入網址還能用）。
   * ⚠️ 這正是最容易被好意破壞的狀態：有人看到 app/ 底下有四個 live 目錄、
   * 導覽列只有一個，會以為是漏加。這條測試就是那個「不是漏掉」的證據。
   */
  it("🔴 導覽列只剩 /live4——live、live2、live3 都是刻意拿掉的", () => {
    const lives = nav.filter((i) => i.href.startsWith("/live")).map((i) => i.href);
    expect(lives).toEqual(["/live4"]);
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
