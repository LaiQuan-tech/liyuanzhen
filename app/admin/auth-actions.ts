"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabase-auth";

/**
 * 登出。
 *
 * ⚠️ 刻意不放在 `actions.ts` 裡：那個檔案的規矩是「每一支開頭都要 requireAdmin()」，
 * 而登出是唯一一支**不該**有權限要求的動作——一個沒有管理權限的帳號登入之後，
 * 最需要做的事就是登出。放在一起遲早會有人照著上面那條規矩加上去，
 * 然後那個人就被鎖在後台裡出不來了。
 */
export async function signOutAction(): Promise<void> {
  const store = cookies();
  const supabase = createAuthServerClient({
    getAll: () => store.getAll(),
    setAll: (list) => {
      for (const c of list) store.set(c.name, c.value, c.options);
    },
  });
  await supabase.auth.signOut();
  redirect("/admin/login");
}
