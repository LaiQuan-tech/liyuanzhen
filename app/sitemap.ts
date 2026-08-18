import type { MetadataRoute } from "next";

/**
 * ⚠️ 現在全站是 noindex（app/robots.ts 的 disallow: /），所以這份 sitemap
 * 實際上不會被任何搜尋引擎讀到。先建好放著是刻意的：
 * 開放收錄那天只要動 robots.ts 與 layout.tsx 的兩處 noindex，
 * 不用再回頭補這個檔——少一件會被忘記的事。
 *
 * ⚠️ 新增路由時要回來加。這裡沒有自動掃描 app/ 的機制。
 */
const ROUTES = ["", "/live", "/chat", "/events", "/about-ai", "/privacy"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://liyuanzhen.vercel.app";
  return ROUTES.map((path) => ({
    url: `${base}${path}`,
    lastModified: new Date(),
    changeFrequency: path === "" ? "weekly" : "monthly",
    priority: path === "" ? 1 : path === "/live" ? 0.9 : 0.6,
  }));
}
