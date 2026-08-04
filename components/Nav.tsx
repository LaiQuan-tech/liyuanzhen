import Link from "next/link";
import { nav, DEMO_BADGE } from "@/content/site";

export default function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b-[1.5px] border-ink/15 bg-paper/85 backdrop-blur-xl">
      <div className="lz-wrap-wide flex items-center justify-between gap-4 py-3">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border-[1.5px] border-ink bg-brand font-display text-[15px] font-extrabold">
            李
          </span>
          <span className="font-display text-[15px] font-extrabold">李元貞 × AI 數位人</span>
          <span className="lz-pill hidden sm:inline-flex">{DEMO_BADGE}</span>
        </Link>

        <nav className="hidden items-center gap-1 lg:flex">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-full px-3 py-1.5 text-[13.5px] font-medium text-muted transition hover:bg-brand-wash hover:text-ink"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <Link href="/chat" className="lz-cta shrink-0 !px-5 !py-2.5 !text-[14px] lg:hidden">
          開始對話
        </Link>
      </div>
    </header>
  );
}
