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
  return createClient(url, key, { auth: { persistSession: false } });
}
