import type { MetadataRoute } from "next";

/**
 * ⚠️ 現在全站是 noindex（app/robots.ts 的 disallow: /），所以這份 sitemap
 * 實際上不會被任何搜尋引擎讀到。先建好放著是刻意的：
 * 開放收錄那天只要動 robots.ts 與 layout.tsx 的兩處 noindex，
 * 不用再回頭補這個檔——少一件會被忘記的事。
 *
 * ⚠️ 新增路由時要回來加。這裡沒有自動掃描 app/ 的機制。
 *
 * 🔴 但有一個**刻意的例外**，不要順手補齊：`/chibi`。它是內部技術驗證頁，
 * 不是給訪客看的內容，也有自己的 `robots: noindex`，永遠不用加進來。
 *
 * ✅ `/live4` 以前是同類的例外（畫面上的 Q 版肖像使用範圍當時還待老師本人與
 * 婦權會確認），2026-09-30 專案擁有者確認已經過老師（經婦權會）確認可以使用，
 * 所以已經拿掉那道頁面層 noindex、加進下面的 ROUTES——見 `app/live4/page.tsx` 檔頭。
 */
const ROUTES = ["", "/live", "/live2", "/live3", "/live4", "/chat", "/events", "/about-ai", "/privacy"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://liyuanzhen.vercel.app";
  return ROUTES.map((path) => ({
    url: `${base}${path}`,
    lastModified: new Date(),
    changeFrequency: path === "" ? "weekly" : "monthly",
    priority: path === "" ? 1 : path.startsWith("/live") ? 0.9 : 0.6,
  }));
}
