import type { MetadataRoute } from "next";

/**
 * ⚠️ 全站禁止索引，這是刻意的，不是漏設。
 *
 * 本站模擬的是一位在世公眾人物，而肖像與內容授權要到第一階段簽約後才會取得。
 * 在那之前被搜尋引擎收錄，對老師與我們都是風險。
 * 正式版取得授權後才可以改成允許索引，並同步移除 layout.tsx 的 noindex meta。
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }],
  };
}
