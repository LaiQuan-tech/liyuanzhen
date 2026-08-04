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
  title: site.title,
  description: site.description,
  // 這是尚未取得肖像授權的提案展示版，模擬的是在世公眾人物。
  // 在正式授權前，絕對不可以被搜尋引擎收錄。改動此處前請先讀 README 的倫理章節。
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
        <meta name="robots" content="noindex,nofollow" />
      </head>
      <body className={`${baloo.variable} ${noto.variable}`}>{children}</body>
    </html>
  );
}
