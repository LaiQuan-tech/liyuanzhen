"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createAuthBrowserClient, hasAuthCredentials } from "@/lib/supabase-auth";

/**
 * 後台登入。
 *
 * ⚠️ 這一頁是 client component，因為 `signInWithPassword` 必須在瀏覽器端跑——
 * 它要把 session 寫進 cookie，而那個動作是 @supabase/ssr 的瀏覽器 client 做的。
 *
 * 🔴 **刻意不做「還沒有管理員就自動建一個」的 bootstrap。**
 * 那種端點的邏輯是「目前沒有管理員時，任何人都可以把自己設成管理員」。
 * 只要漏擋一次，或是有人在正式站上搶在你之前打它，整個後台就是別人的。
 * 第一個管理員在 Supabase Dashboard 手動建，步驟寫在 0004_events_admin.sql 第五節。
 */
export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!hasAuthCredentials()) {
    return (
      <main className="mx-auto max-w-lg px-6 py-24">
        <h1 className="font-display text-[22px] font-bold">後台尚未設定</h1>
        <p className="mt-3 text-[14.5px] leading-relaxed text-ink-soft">
          缺少 <code className="text-[13px]">NEXT_PUBLIC_SUPABASE_URL</code> 或{" "}
          <code className="text-[13px]">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>。
          兩個都要加進 <code className="text-[13px]">.env.local</code>{" "}
          <strong>以及 Vercel 的環境變數</strong>——只加本機的話，正式站會停在這一頁。
        </p>
      </main>
    );
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);

    if (!email.trim() || !password) {
      setError("請填電子郵件與密碼。");
      return;
    }

    setBusy(true);
    const supabase = createAuthBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (signInError) {
      setBusy(false);
      // ⚠️ 不要把 Supabase 的原文吐出來，也不要分辨「沒這個帳號」與「密碼錯」——
      // 那等於提供一支查詢「這個信箱有沒有註冊過」的端點。
      setError("電子郵件或密碼不正確。");
      return;
    }

    // ⚠️ 一定要 refresh()。middleware 是在伺服器端讀 cookie 的，
    // 少了這一行，router.push 會用還沒更新的 RSC 快取，被 middleware 踢回來。
    const next = params.get("next");
    router.replace(next && next.startsWith("/admin") ? next : "/admin");
    router.refresh();
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="font-display text-[22px] font-extrabold">活動後台</h1>
      <p className="mt-2 text-[13.5px] text-muted">
        這是「數位李元貞」網站的活動管理介面。
      </p>

      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-[13.5px] font-bold">電子郵件</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border-[1.5px] border-ink/30 bg-paper-alt px-3 py-2.5 text-[15px] outline-none focus:border-ink"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[13.5px] font-bold">密碼</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border-[1.5px] border-ink/30 bg-paper-alt px-3 py-2.5 text-[15px] outline-none focus:border-ink"
          />
        </label>

        {error && (
          <p role="alert" className="text-[13.5px] text-wine">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-full bg-ink px-6 py-3 font-display text-[15px] font-bold text-white disabled:opacity-50"
        >
          {busy ? "登入中…" : "登入"}
        </button>
      </form>
    </main>
  );
}
