import type { MetadataRoute } from "next";

/**
 * ⚠️ 現在全站是 noindex（app/robots.ts 的 disallow: /），所以這份 sitemap
 * 實際上不會被任何搜尋引擎讀到。先建好放著是刻意的：
 * 開放收錄那天只要動 robots.ts 與 layout.tsx 的兩處 noindex，
 * 不用再回頭補這個檔——少一件會被忘記的事。
 *
 * ⚠️ 新增路由時要回來加。這裡沒有自動掃描 app/ 的機制。
 *
 * 🔴 但有兩個**刻意的例外**，不要順手補齊：`/live4` 與 `/chibi`。
 * 兩頁畫面上都是李元貞老師的 Q 版肖像**草案**，使用範圍仍待老師本人與
 * 婦權會確認，兩頁也都有自己的 `robots: noindex`。sitemap 是「請來索引我」
 * 的訊號，跟 noindex 放在一起只會互相矛盾。
 * 授權範圍確認之後再把 `/live4` 加進來（`/chibi` 是內部測試頁，永遠不用加）。
 */
const ROUTES = ["", "/live", "/live2", "/live3", "/chat", "/events", "/about-ai", "/privacy"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "https://liyuanzhen.vercel.app";
  return ROUTES.map((path) => ({
    url: `${base}${path}`,
    lastModified: new Date(),
    changeFrequency: path === "" ? "weekly" : "monthly",
    priority: path === "" ? 1 : path.startsWith("/live") ? 0.9 : 0.6,
  }));
}
