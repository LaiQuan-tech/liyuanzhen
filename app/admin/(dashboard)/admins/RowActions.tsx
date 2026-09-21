"use client";

import { useId, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  setRoleAction,
  resetPasswordAction,
  revokeRoleAction,
  deleteAccountAction,
} from "./actions";
import {
  ADMIN_ROLES,
  ROLE_LABEL,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULE_HINT,
  IDLE_STATE,
  type AdminActionState,
  type AdminRole,
  // 🔴 從 `@/lib/admins/types` 進來，**不要**從 `@/lib/admins`。
  // 那個 barrel 會 re-export `./index.ts`，而它 import 了 `./provision.ts`
  // → `lib/admin-auth.ts` → `next/headers`，在 client component 裡直接
  // build 失敗（"You're importing a component that needs next/headers"）。
  // ⚠️ tsc --noEmit 不會擋這個，只有 npm run build 會。
} from "@/lib/admins/types";

/**
 * 一列人員的四個操作：改層級／重設密碼／移除權限／刪除帳號。
 *
 * 🔴 **四個動作分開，不合成一顆「編輯」**，因為它們的可逆性完全不同：
 *
 *   改層級      可逆
 *   重設密碼    對方原本的密碼立刻失效，但帳號還在
 *   移除權限    可逆（在「新增人員」填同一個信箱就會加回來，密碼不變）
 *   刪除帳號    **不可逆**
 *
 * 藏在同一顆按鈕後面會讓人以為它們差不多。
 *
 * 🔴 **自己那一列完全不渲染破壞性操作**，只印「（你自己）」。
 * ⚠️ 但那只是體驗——真正擋住的是 `actions.ts` 裡每一支的 `userId === actor.id`
 * 檢查。這裡藏起來的東西，在 devtools 裡照樣送得出去。
 *
 * ⚠️ 用 `useFormState` 不是 `useActionState`（React 18 / Next 14.2）。
 * 每一顆按鈕各自帶一份狀態，錯誤訊息才會出現在按下去的那一顆旁邊——
 * 而「最後一位管理員」這種錯誤如果沒有地方顯示，就會變成一個 500 白畫面。
 */

function Pending({ label, busy = "…" }: { label: string; busy?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      // whitespace-nowrap：這幾顆按鈕都在窄格子裡，沒有它「更新」會斷成直排的兩個字
      className="whitespace-nowrap rounded-lg border-[1.5px] border-ink/25 px-2.5 py-1 text-[12.5px] font-bold hover:border-ink disabled:opacity-40"
    >
      {pending ? busy : label}
    </button>
  );
}

function Feedback({ state }: { state: AdminActionState }) {
  if (state.errors.length === 0 && !state.message) return null;
  if (state.errors.length > 0) {
    return (
      <p role="alert" className="text-[12px] leading-relaxed text-wine">
        {state.errors.join("；")}
      </p>
    );
  }
  return (
    <p role="status" className="text-[12px] leading-relaxed text-ok">
      {state.message}
    </p>
  );
}

export default function RowActions({
  userId,
  email,
  role,
  isSelf,
}: {
  userId: string;
  email: string;
  role: AdminRole;
  isSelf: boolean;
}) {
  const uid = useId();
  const [openPassword, setOpenPassword] = useState(false);

  const [roleState, roleAction] = useFormState<AdminActionState, FormData>(
    setRoleAction,
    IDLE_STATE
  );
  const [pwState, pwAction] = useFormState<AdminActionState, FormData>(
    resetPasswordAction,
    IDLE_STATE
  );
  const [revokeState, revokeFormAction] = useFormState<AdminActionState, FormData>(
    revokeRoleAction,
    IDLE_STATE
  );
  const [deleteState, deleteFormAction] = useFormState<AdminActionState, FormData>(
    deleteAccountAction,
    IDLE_STATE
  );

  if (isSelf) {
    // 破壞性操作一個都不渲染。降級自己＝把自己鎖在人員管理外面。
    return <span className="text-[12.5px] text-muted">（你自己）</span>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      {/*
        改層級：select ＋ 獨立的「更新」按鈕，**不是選了就送出**。
        誤觸一個下拉選單就改掉別人的權限太容易了。
      */}
      <form action={roleAction} className="flex items-center gap-1.5">
        <input type="hidden" name="user_id" value={userId} />
        <select
          name="role"
          defaultValue={role}
          aria-label={`${email} 的層級`}
          className="rounded-lg border-[1.5px] border-ink/25 bg-paper-alt px-2 py-1 text-[12.5px]"
        >
          {ADMIN_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <Pending label="更新" />
      </form>
      <Feedback state={roleState} />

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpenPassword((v) => !v)}
          aria-expanded={openPassword}
          aria-controls={`${uid}-pw`}
          className="whitespace-nowrap rounded-lg border-[1.5px] border-ink/25 px-2.5 py-1 text-[12.5px] font-bold hover:border-ink"
        >
          重設密碼
        </button>

        <form
          action={revokeFormAction}
          onSubmit={(e) => {
            // ⚠️ 文案要把「可逆」講出來，才分得出跟下面那顆的差別。
            if (
              !confirm(
                `移除 ${email} 的後台權限？\n\n帳號會保留。之後在「新增人員」填同一個信箱就會加回來，而且密碼不變。\n\n這個動作可以反悔。`
              )
            ) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="user_id" value={userId} />
          <Pending label="移除權限" />
        </form>

        <form
          action={deleteFormAction}
          onSubmit={(e) => {
            // 🔴 文案要把「不可逆」講出來，而且指出比較輕的那條路。
            if (
              !confirm(
                `⚠️ 刪除 ${email} 的整個帳號？\n\n這個動作救不回來，之後要重新建立帳號與密碼。\n\n只是想暫時停權的話，請改用「移除權限」——那個帳號會留著，密碼也不變。`
              )
            ) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="user_id" value={userId} />
          <button
            type="submit"
            className="whitespace-nowrap rounded-lg border-[1.5px] border-wine px-2.5 py-1 text-[12.5px] font-bold text-wine hover:bg-wine-wash"
          >
            刪除帳號
          </button>
        </form>
      </div>
      <Feedback state={revokeState} />
      <Feedback state={deleteState} />

      {openPassword && (
        <form id={`${uid}-pw`} action={pwAction} className="flex flex-wrap items-center gap-1.5">
          <input type="hidden" name="user_id" value={userId} />
          {/*
            ⚠️ type="text"：操作者是在幫別人設定，看不到自己打了什麼
            就沒辦法正確轉達。
          */}
          <input
            name="password"
            type="text"
            autoComplete="off"
            required
            minLength={PASSWORD_MIN_LENGTH}
            title={PASSWORD_RULE_HINT}
            placeholder="新密碼"
            aria-label={`${email} 的新密碼`}
            className="w-40 rounded-lg border-[1.5px] border-ink/25 bg-paper-alt px-2 py-1 text-[12.5px]"
          />
          <Pending label="送出" />
        </form>
      )}
      <Feedback state={pwState} />
    </div>
  );
}
