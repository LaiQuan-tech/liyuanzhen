"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { MAX_PARTY_SIZE } from "@/lib/events/types";

/**
 * 活動報名表單。
 *
 * ⚠️ 這是全站唯一一個會蒐集姓名、信箱、電話的地方。
 * 同意勾選是**必填而且預設不勾**——預設勾起來等於替使用者按同意，
 * 那在個資法上是有問題的，在道義上更是。
 *
 * ⚠️ 送出走 `/api/events/[slug]/signup`（service_role），不是讓瀏覽器直接寫資料庫。
 * 理由寫在那支 route 的檔頭。
 */
export default function SignupForm({ slug, note }: { slug: string; note: string | null }) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);

    const form = new FormData(e.currentTarget);
    const res = await fetch(`/api/events/${slug}/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        email: form.get("email"),
        phone: form.get("phone"),
        party_size: Number(form.get("party_size") ?? 1),
        note: form.get("note"),
        consent: form.get("consent") === "on",
      }),
    }).catch(() => null);

    setBusy(false);

    if (!res) {
      setError("網路好像不太穩，請再送一次。");
      return;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "報名沒有送出，請再試一次。");
      return;
    }
    setDone(true);
  };

  if (done) {
    return (
      <div className="lz-card mt-8 p-6">
        <span className="lz-pill">已收到</span>
        <h2 className="lz-h3 mt-3">報名完成</h2>
        <p className="mt-2 text-[14.5px] leading-relaxed text-ink-soft">
          我們已經收到你的報名。
          {/*
            ⚠️ 不要寫「確認信已寄出」——這個站目前沒有任何寄信功能。
            承諾一封不會到的信，比不承諾更糟。
          */}
          活動前的通知會由主辦單位另行聯絡；有問題可以直接回信給基金會。
        </p>
      </div>
    );
  }

  const field =
    "w-full rounded-lg border-[1.5px] border-ink/25 bg-paper-alt px-3 py-2.5 text-[15px] outline-none focus:border-ink";

  return (
    <form onSubmit={onSubmit} className="lz-card mt-8 space-y-5 p-6">
      <div>
        <h2 className="lz-h3">線上報名</h2>
        {note && <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">{note}</p>}
      </div>

      <label className="block">
        <span className="mb-1.5 block text-[13.5px] font-bold">姓名</span>
        <input name="name" required maxLength={100} className={field} />
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-[13.5px] font-bold">電子郵件</span>
          <input name="email" type="email" required maxLength={200} className={field} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[13.5px] font-bold">
            電話 <span className="font-normal text-muted">（選填）</span>
          </span>
          <input name="phone" type="tel" maxLength={40} className={field} />
        </label>
      </div>

      <label className="block sm:max-w-[10rem]">
        <span className="mb-1.5 block text-[13.5px] font-bold">人數</span>
        <select name="party_size" defaultValue="1" className={field}>
          {Array.from({ length: MAX_PARTY_SIZE }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n} 人
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1.5 block text-[13.5px] font-bold">
          備註 <span className="font-normal text-muted">（選填）</span>
        </span>
        <textarea name="note" rows={3} maxLength={1000} className={field} />
      </label>

      {/* 🔴 預設不勾，而且必填。理由見檔頭。 */}
      <label className="flex items-start gap-2.5">
        <input type="checkbox" name="consent" required className="mt-1 h-4 w-4 shrink-0" />
        <span className="text-[13.5px] leading-relaxed text-ink-soft">
          我同意主辦單位為了這場活動的聯絡與出席管理，保留我填寫的姓名、電子郵件與電話。
          詳見{" "}
          <Link href="/privacy" className="underline underline-offset-2">
            隱私權政策
          </Link>
          。
        </span>
      </label>

      {error && (
        <p role="alert" className="text-[13.5px] text-wine">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="lz-cta w-full justify-center disabled:opacity-50 sm:w-auto"
      >
        {busy ? "送出中…" : "送出報名"}
      </button>
    </form>
  );
}
