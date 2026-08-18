import type { MetadataRoute } from "next";

/**
 * ⚠️ 全站禁止索引，這是**刻意的決定**，不是還沒解除的暫時設定。
 *
 * 肖像與內容授權都已經由李元貞老師書面簽妥，站上用的是她本人的照片、
 * 她的克隆聲音與即時對嘴影片。授權並沒有讓這一行變得可以拿掉：
 * **肖像授權不等於搜尋引擎授權**，那是兩件不同的許可；而且搜尋結果頁只會
 * 顯示標題與摘要，不會顯示「這是 AI」——一旦被收錄，內容就跟它的揭露脫鉤了。
 *
 * 要開放收錄請當成一次獨立決策，並且**同時**改三處：
 * 這裡的 disallow、app/layout.tsx 的 metadata.robots、
 * 以及 app/layout.tsx 的 <head> 裡手寫的那行 meta。只改一處等於沒改。
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }],
  };
}
