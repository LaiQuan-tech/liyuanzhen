"use client";

import { useFormState, useFormStatus } from "react-dom";
import { createAdminAction } from "./actions";
import {
  ADMIN_ROLES,
  ROLE_LABEL,
  ROLE_HINT,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULE_HINT,
  IDLE_STATE,
  type AdminActionState,
  // 🔴 從 `@/lib/admins/types` 進來，不要從 `@/lib/admins`——理由見 RowActions.tsx。
} from "@/lib/admins/types";

/**
 * 新增後台人員。
 *
 * ⚠️ 用原生 form ＋ server action ＋ `useFormState`，形狀照 `EventForm.tsx`。
 * **不是** `useActionState`——這個專案是 React 18（Next 14.2），那支 hook
 * 要 React 19。
 *
 * 🔴 **由操作者直接設初始密碼**，沒有邀請信這條路：這個站沒有接寄信服務。
 * 所以密碼是當面或用電話交給對方的，`email_confirm` 也必須是 true
 * （見 lib/admins/provision.ts）。
 */

const FIELD =
  "w-full rounded-lg border-[1.5px] border-ink/25 bg-paper-alt px-3 py-2 text-[15px] outline-none focus:border-ink";

function SubmitButton() {
  // ⚠️ useFormStatus 必須在 <form> 的子元件裡才讀得到狀態，
  // 寫在同一層會永遠是 false，按鈕就不會有送出中的樣子。
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-full bg-ink px-6 py-3 font-display text-[15px] font-bold text-white disabled:opacity-50"
    >
      {pending ? "新增中…" : "新增人員"}
    </button>
  );
}

export default function AdminForm() {
  const [state, formAction] = useFormState<AdminActionState, FormData>(
    createAdminAction,
    IDLE_STATE
  );

  return (
    <form action={formAction} className="mt-6 max-w-xl space-y-4">
      {state.errors.length > 0 && (
        <div role="alert" className="rounded-lg bg-wine-wash p-4">
          <p className="text-[13.5px] font-bold text-wine">這些地方要修一下：</p>
          <ul className="mt-1.5 list-disc pl-5 text-[13.5px] leading-relaxed text-ink-soft">
            {state.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {state.message && (
        <p role="status" className="rounded-lg bg-brand-wash p-4 text-[13.5px] leading-relaxed">
          {state.message}
        </p>
      )}

      <label className="block">
        <span className="mb-1.5 block text-[13.5px] font-bold">電子信箱</span>
        <input
          name="email"
          type="email"
          autoComplete="off"
          className={FIELD}
          placeholder="someone@example.com"
        />
        <span className="mt-1 block text-[12.5px] text-muted">
          這個信箱如果已經有帳號，會直接加進後台，<strong>密碼維持原本那組</strong>。
        </span>
      </label>

      <label className="block">
        <span className="mb-1.5 block text-[13.5px] font-bold">初始密碼</span>
        {/*
          ⚠️ type="text" 不是 password：操作者是在幫別人設定，
          看不到自己打了什麼就沒辦法正確轉達。
          ⚠️ minLength 只是讓瀏覽器先擋一次；真正的規則在 lib/admins/types.ts
          的 passwordProblems()，那是唯一的防線（Supabase 專案的密碼原則
          多半還是預設的 6 碼、沒有字元類別要求）。
        */}
        <input
          name="password"
          type="text"
          autoComplete="off"
          minLength={PASSWORD_MIN_LENGTH}
          title={PASSWORD_RULE_HINT}
          className={FIELD}
        />
        <span className="mt-1 block text-[12.5px] text-muted">
          {PASSWORD_RULE_HINT}。這個站沒有寄信服務，所以請當面或用電話把密碼交給對方。
          前後的空白會被當成密碼的一部分。
        </span>
      </label>

      <label className="block">
        <span className="mb-1.5 block text-[13.5px] font-bold">層級</span>
        <select name="role" className={FIELD} defaultValue="editor">
          {ADMIN_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-[12.5px] leading-relaxed text-muted">
          {ADMIN_ROLES.map((r) => (
            <span key={r} className="block">
              {ROLE_LABEL[r]}：{ROLE_HINT[r]}
            </span>
          ))}
        </span>
      </label>

      <div className="pt-2">
        <SubmitButton />
      </div>
    </form>
  );
}
