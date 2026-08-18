import type { Metadata, Viewport } from "next";
import { Baloo_2, Noto_Sans_TC } from "next/font/google";
import { site } from "@/content/site";
import "./globals.css";

const baloo = Baloo_2({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-baloo",
  display: "swap",
});

const noto = Noto_Sans_TC({
  subsets: ["latin"],
  weight: ["400", "500", "700", "900"],
  variable: "--font-noto",
  display: "swap",
});

export const metadata: Metadata = {
  // ⚠️ 沒有 metadataBase 的話，OG 的相對路徑會壞掉（Next 會警告並用 localhost）
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://liyuanzhen.vercel.app"),
  title: site.title,
  description: site.description,

  openGraph: {
    type: "website",
    locale: "zh_TW",
    siteName: site.name,
    title: site.title,
    description: site.description,
    // ⚠️ 目前沒有 OG 圖，分享出去會是純文字卡。
    // 她的授權照片放進 public/ 之後，在這裡指過去就有圖了。
  },
  twitter: { card: "summary_large_image", title: site.title, description: site.description },

  /**
   * ⚠️ 全站禁止索引，這是**刻意的決定**，不是還沒解除的暫時設定。
   *
   * 肖像授權不等於搜尋引擎授權，是兩件不同的許可；而且搜尋結果頁不會顯示
   * 「這是 AI」，被收錄之後那層揭露就跟著內容脫鉤了。
   * 要開放收錄請當成獨立決策，並且**同時**改三處：
   * 這裡的 robots、下方 <head> 裡手寫的 meta、以及 app/robots.ts。
   * 只改一處等於沒改。
   */
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
};

export const viewport: Viewport = {
  themeColor: "#FFCE00",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <head>
        {/* 第二處 noindex。三處要一起改，理由見上方 metadata.robots 的註解。 */}
        <meta name="robots" content="noindex,nofollow" />
      </head>
      <body className={`${baloo.variable} ${noto.variable}`}>{children}</body>
    </html>
  );
}
