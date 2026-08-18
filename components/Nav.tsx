"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { nav, footerLinks } from "@/content/site";

/**
 * 頁首導覽。
 *
 * ⚠️ 這是 client component，而且**不要**改回用 `<details>` / `<summary>` 的純 CSS 版。
 * `open` 是未受控的 DOM 屬性，App Router 換頁時 React 會重用同一個節點，
 * 結果是**選單不會關**——點「文字對話」跳頁之後它還開著。
 * 這個元件很小，而且 /live 根本不掛 Nav，client 化的代價可以忽略。
 *
 * lg 以下原本**完全沒有選單**，四個導覽連結全部消失，只剩一顆按鈕——
 * 平板與所有手機使用者都到不了 /live 以外的頁面。這次補上。
 */
export default function Nav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // 換頁就關。少了這行，點選單裡的連結跳頁之後面板會留在畫面上。
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-50 border-b-[1.5px] border-ink/15 bg-paper/85 backdrop-blur-xl">
      <div className="lz-wrap-wide flex items-center justify-between gap-3 py-3">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border-[1.5px] border-ink bg-brand font-display text-[15px] font-extrabold">
            李
          </span>
          <span className="font-display text-[15px] font-extrabold">李元貞 × AI 數位人</span>
        </Link>

        <nav className="hidden items-center gap-1 lg:flex">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-full px-3 py-1.5 text-[13.5px] font-medium text-muted transition hover:bg-flame-wash hover:text-ink"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {/* 主行動是 /live，不是 /chat */}
          <Link href="/live" className="lz-cta !px-4 !py-2 !text-[13.5px] lg:hidden">
            <span className="sm:hidden">問她</span>
            <span className="hidden sm:inline">面對面問她</span>
          </Link>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label="選單"
            className="flex h-11 w-11 items-center justify-center rounded-lg border-[1.5px] border-ink bg-paper-alt lg:hidden"
          >
            <span className="relative block h-[12px] w-[18px]">
              {/* 三條線在開啟時併成 ×，全部用 utility，不需要新 CSS */}
              <span
                className={`absolute left-0 h-[2px] w-full bg-ink transition-all duration-200 ${
                  open ? "top-[5px] rotate-45" : "top-0"
                }`}
              />
              <span
                className={`absolute left-0 top-[5px] h-[2px] w-full bg-ink transition-opacity duration-200 ${
                  open ? "opacity-0" : "opacity-100"
                }`}
              />
              <span
                className={`absolute left-0 h-[2px] w-full bg-ink transition-all duration-200 ${
                  open ? "top-[5px] -rotate-45" : "top-[10px]"
                }`}
              />
            </span>
          </button>
        </div>
      </div>

      {open && (
        <div
          id="mobile-nav"
          className="absolute inset-x-0 top-full border-b-2 border-ink bg-paper shadow-sticker-lg lg:hidden"
        >
          {/* 刻意不做 body scroll lock：六列在任何手機視窗都放得下，少一個會壞的東西 */}
          {[...nav, ...footerLinks].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex h-12 items-center border-b border-ink/10 px-5 text-[15px] font-medium"
            >
              {item.label}
            </Link>
          ))}
          <div className="p-4">
            <Link href="/live" className="lz-cta w-full justify-center !flex">
              面對面問她 →
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}
