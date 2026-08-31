import { currentUser, isAdmin } from "@/lib/admin-auth";
import { hasAuthCredentials } from "@/lib/supabase-auth";
import AdminSidebar from "@/components/admin/AdminSidebar";
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
 * 🔴 **這個檔案必須留在 server component。** 底下兩個 `await` 就是那第二道檢查；
 * 為了做側邊欄的 active 高亮或手機收合而在這裡加 "use client"，會讓它們整個失效。
 * 那些需要 client 的部分關在 `components/admin/AdminSidebar.tsx` 那一片葉子裡。
 *
 * 樣式刻意不套 .lz-cta / sticker 陰影那一套。那是對外頁面的語言，
 * 後台要的是掃得快、資訊密度高。
 */
export const dynamic = "force-dynamic";

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
    <div className="min-h-screen bg-paper-alt text-ink lg:flex">
      <AdminSidebar email={user?.email} />
      {/*
        ⚠️ `min-w-0` 不能拿掉。flex 子項的預設 min-width 是 auto，
        報名名單與問答紀錄的表格都有 min-w-[…px]，沒有這一行的話
        表格會把整個版面撐開，橫向捲軸跑到 <body> 上而不是表格自己身上。
      */}
      <main className="min-w-0 flex-1 px-5 py-8 lg:px-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
