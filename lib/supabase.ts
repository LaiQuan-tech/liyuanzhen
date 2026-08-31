import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Stage 2 才會有值；沒設就代表整站跑在本機向量檔模式 */
export function hasSupabase(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** service_role：繞過 RLS，只能在 server 端用，絕不可出現在 "use client" 檔案 */
export function createAdminSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY 必須設定");
  }
  return createClient(url, key, {
    auth: { persistSession: false },
    global: {
      /**
       * 🔴 一定要 no-store。
       *
       * Next 會接管全域 fetch 並自動快取，而 supabase-js 的每一次查詢都是 fetch。
       * `export const dynamic = "force-dynamic"` **擋不住這一層**——那管的是頁面
       * 要不要預先產生，管不到 fetch 自己的 Data Cache。
       *
       * 症狀非常難查：後台把活動改成 published，公開頁還是看不到；把活動下架了，
       * 公開頁還在賣票。而且重新部署一次就會「好了」，於是很容易被誤判成偶發。
       *（IFAR 那個站踩過同一個坑：刪掉的資料在查詢頁還查得到。）
       *
       * 這個 client 的每一個用途——語料檢索、互動紀錄、虛擬人帳本、活動——
       * 要的都是「現在的事實」，沒有任何一個場景想要快取。所以設在這裡，
       * 不做成可選參數：可選的東西總有一天會有人忘記傳。
       */
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
  });
}
