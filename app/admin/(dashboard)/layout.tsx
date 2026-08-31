import Link from "next/link";
import { currentUser, isAdmin } from "@/lib/admin-auth";
import { hasAuthCredentials } from "@/lib/supabase-auth";
import { signOutAction } from "../auth-actions";

/**
 * 後台外殼。
 *
 * ⚠️ 路由群組 `(dashboard)` 不會出現在網址裡，存在的理由是把 `/admin/login`
 * 排除在這個外殼之外——登入頁不能套用「要先是管理員」的檢查，否則沒有人進得來。
 *
 * 🔴 這裡的檢查是**第二道**，不是唯一一道。
 * middleware 擋「沒登入」，這裡擋「登入了但沒有權限」，而真正的閘門在每一支
 * server action 開頭的 `requireAdmin()`。頁面層的檢查只保護「看得到什麼」，
 * 保護不了「做得到什麼」——那兩件事在 App Router 裡是分開的。
 *
 * 樣式刻意不套 .lz-cta / sticker 陰影那一套。那是對外頁面的語言，
 * 後台要的是掃得快、資訊密度高。
 */
export const dynamic = "force-dynamic";

const NAV = [
  { href: "/admin", label: "場次" },
  { href: "/events", label: "看公開頁", external: true },
] as const;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // 還沒設定就講清楚是哪一步沒做。⚠️ 這一段要放在權限檢查之前——
  // 沒有 anon key 時 currentUser() 一律回 null，會被誤判成「沒有權限」，
  // 那個訊息會讓人跑去查 user_roles，而真正的問題在環境變數。
  if (!hasAuthCredentials()) {
    return (
      <main className="mx-auto max-w-lg px-6 py-24">
        <h1 className="font-display text-[22px] font-bold">後台尚未設定</h1>
        <p className="mt-3 text-[14.5px] leading-relaxed text-ink-soft">
          缺少 <code className="text-[13px]">NEXT_PUBLIC_SUPABASE_URL</code> 或{" "}
          <code className="text-[13px]">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>。
          兩個都要加進 <code className="text-[13px]">.env.local</code>
          <strong> 以及 Vercel 的環境變數</strong>。
        </p>
      </main>
    );
  }

  const user = await currentUser();
  const admin = await isAdmin();

  if (!admin) {
    return (
      <main className="mx-auto max-w-lg px-6 py-24">
        <h1 className="font-display text-[22px] font-bold">此帳號沒有管理權限</h1>
        <p className="mt-3 text-[14.5px] leading-relaxed text-ink-soft">
          {user?.email ?? "這個帳號"} 已經登入，但不在管理員名單裡。
          請聯絡系統管理者把這個帳號加進 <code className="text-[13px]">user_roles</code>，
          再重新登入。
        </p>
        <form action={signOutAction} className="mt-6">
          <button
            type="submit"
            className="rounded-lg border-[1.5px] border-ink px-4 py-2 text-[14px] font-bold"
          >
            登出
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-paper-alt text-ink">
      <header className="sticky top-0 z-40 border-b-[1.5px] border-ink/15 bg-paper-alt/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3">
          <span className="font-display text-[15px] font-extrabold">活動後台</span>
          <nav className="flex items-center gap-4 text-[14px]">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-muted underline-offset-4 hover:text-ink hover:underline"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-[12.5px] text-muted">
            <span className="hidden sm:inline">{user?.email}</span>
            <form action={signOutAction}>
              <button type="submit" className="underline underline-offset-4 hover:text-ink">
                登出
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-8">{children}</main>
    </div>
  );
}
