import Link from "next/link";
import { nav, footerLinks, site, SITE_NOTICE } from "@/content/site";

export default function Footer() {
  return (
    <footer className="border-t-2 border-ink bg-paper-alt">
      <div className="lz-wrap-wide py-12">
        {/* 這段揭露必須出現在每一頁的頁尾，不做成可關閉的橫幅 */}
        {/* ⚠️ 拿掉了原本的「⚠️」前綴——展示版時它是警語，正式站上讀起來像網站壞了。
            揭露的內容一個字都沒少，只是不再假裝自己是錯誤訊息。 */}
        <div className="lz-card-wash mb-8 p-4 text-[13px] leading-relaxed text-ink-soft">
          {SITE_NOTICE}
          <Link href="/about-ai" className="ml-1 font-bold underline underline-offset-2">
            了解這個 AI 如何運作
          </Link>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 text-[13.5px]">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="text-muted hover:text-ink">
              {item.label}
            </Link>
          ))}
          {footerLinks.map((item) => (
            <Link key={item.href} href={item.href} className="font-bold text-ink hover:underline">
              {item.label}
            </Link>
          ))}
        </div>

        <p className="mt-8 text-[12.5px] text-muted-light">
          © {site.owner}
        </p>
      </div>
    </footer>
  );
}
