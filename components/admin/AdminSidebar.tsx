"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ADMIN_NAV, isNavActive } from "@/lib/admin-nav";
import { signOutAction } from "@/app/admin/auth-actions";

/**
 * 後台的左側功能列。
 *
 * 🔴 這個檔案是 client component，而 `(dashboard)/layout.tsx` **必須留在 server**——
 * 那裡有 `await currentUser()` / `await isAdmin()` 兩道權限檢查，
 * 整個 layout 標成 "use client" 的話它們會直接垮掉。
 * 所以需要 client 的兩樣東西（usePathname 的 active 高亮、useState 的手機收合）
 * 全部關在這一片葉子裡，email 由 layout 當 prop 傳進來。
 *
 * ⚠️ 收合的作法照抄 components/Nav.tsx，包括那裡的警告：
 * **不要**改用 <details>/<summary> 的純 CSS 版。`open` 是未受控的 DOM 屬性，
 * App Router 換頁時 React 會重用節點，結果選單不會關。
 *
 * 樣式刻意不套 .lz-cta / sticker 陰影那一套——那是對外頁面的語言，
 * 後台要的是掃得快、資訊密度高。
 */
export default function AdminSidebar({ email }: { email?: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

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

  const nav = (
    <nav className="flex flex-col gap-1">
      {ADMIN_NAV.map((item) => {
        const active = isNavActive(pathname, item);
        const className = `rounded-lg px-3 py-2 text-[14.5px] ${
          active ? "bg-brand-wash font-bold text-ink" : "text-muted hover:bg-ink/5 hover:text-ink"
        }`;

        // 對外連結開新分頁。留在同一個分頁的話等於把人帶出後台，
        // 而他手上多半還有沒做完的事。
        if (item.external) {
          return (
            <a
              key={item.href}
              href={item.href}
              target="_blank"
              rel="noreferrer"
              className={`${className} flex items-center gap-1.5`}
            >
              {item.label}
              <span aria-hidden="true" className="text-[11px] text-muted-light">
                ↗
              </span>
              <span className="sr-only">（開新分頁）</span>
            </a>
          );
        }

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={className}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  const footer = (
    <div className="mt-auto border-t border-ink/10 pt-4 text-[12.5px] text-muted">
      {email && <p className="mb-2 break-all">{email}</p>}
      <form action={signOutAction}>
        <button type="submit" className="underline underline-offset-4 hover:text-ink">
          登出
        </button>
      </form>
    </div>
  );

  return (
    <>
      {/* 手機：頂部一條，展開為覆蓋層 */}
      <div className="lg:hidden">
        <div className="sticky top-0 z-40 flex items-center gap-3 border-b-[1.5px] border-ink/15 bg-paper-alt/95 px-4 py-2 backdrop-blur">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="admin-nav"
            aria-label="選單"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border-[1.5px] border-ink/25"
          >
            {/* 三條線併成 ×，不需要新的 CSS */}
            <span className="relative block h-3.5 w-5">
              <span
                className={`absolute left-0 block h-[1.5px] w-5 bg-ink transition-transform ${
                  open ? "top-1.5 rotate-45" : "top-0"
                }`}
              />
              <span
                className={`absolute left-0 top-1.5 block h-[1.5px] w-5 bg-ink transition-opacity ${
                  open ? "opacity-0" : "opacity-100"
                }`}
              />
              <span
                className={`absolute left-0 block h-[1.5px] w-5 bg-ink transition-transform ${
                  open ? "top-1.5 -rotate-45" : "top-3"
                }`}
              />
            </span>
          </button>
          <span className="font-display text-[15px] font-extrabold">活動後台</span>
        </div>

        {open && (
          <div
            id="admin-nav"
            className="sticky top-[3.75rem] z-30 flex max-h-[calc(100vh-3.75rem)] flex-col overflow-y-auto border-b-[1.5px] border-ink/15 bg-paper-alt px-4 py-4"
          >
            {nav}
            {footer}
          </div>
        )}
      </div>

      {/* 桌機：固定在左邊的一欄 */}
      <aside className="hidden w-52 shrink-0 border-r-[1.5px] border-ink/15 lg:block">
        <div className="sticky top-0 flex h-screen flex-col px-4 py-5">
          <span className="mb-5 px-3 font-display text-[15px] font-extrabold">活動後台</span>
          {nav}
          {footer}
        </div>
      </aside>
    </>
  );
}
