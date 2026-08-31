import { createBrowserClient, createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 後台登入用的 Supabase client。
 *
 * ⚠️ 這個檔案跟 `lib/supabase.ts` 是**兩件不同的事**，不要合併：
 *
 *   lib/supabase.ts       service_role，繞過 RLS，只能在伺服器端用，
 *                         絕不可出現在 "use client" 檔案
 *   lib/supabase-auth.ts  anon key ＋ 使用者的 session，會出現在瀏覽器端
 *
 * 混在一起的後果不是「程式碼比較亂」，是有一天 service_role 金鑰被 import
 * 進一個 client component，然後整包打進瀏覽器。那把金鑰能讀寫這個專案的
 * 每一張表，包含訪客提問全文與活動報名的姓名電話。
 */

/** anon key 是設計上就會公開的（它受 RLS 保護），但沒設就什麼都動不了。 */
export function hasAuthCredentials(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

function credentials(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL 與 NEXT_PUBLIC_SUPABASE_ANON_KEY 必須設定。" +
        "⚠️ 本機改完 .env.local 之外，Vercel 的環境變數也要加，否則正式站會壞。"
    );
  }
  return { url, key };
}

/** 瀏覽器端。登入、登出、讀目前的 session。 */
export function createAuthBrowserClient(): SupabaseClient {
  const { url, key } = credentials();
  return createBrowserClient(url, key);
}

/**
 * 伺服器端（server component / server action / route handler）。
 *
 * ⚠️ `cookies` 要由呼叫端傳進來，不要在這裡 `import { cookies } from "next/headers"`——
 * middleware 用的是 request/response 上的 cookie，跟 next/headers 是兩套 API，
 * 寫死一套會讓另一套沒辦法共用這個檔案。
 */
export function createAuthServerClient(store: {
  getAll(): { name: string; value: string }[];
  setAll(cookies: { name: string; value: string; options?: object }[]): void;
}): SupabaseClient {
  const { url, key } = credentials();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          store.setAll(list);
        } catch {
          // ⚠️ 在 server component 裡寫 cookie 會丟例外，那是正常的：
          // session 的續期交給 middleware 做。這裡吞掉是官方建議的作法，
          // 不是在藏錯誤。
        }
      },
    },
  });
}
