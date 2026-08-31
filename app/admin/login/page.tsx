import { Suspense } from "react";
import LoginForm from "./LoginForm";

/**
 * ⚠️ 這一層是 server component，只為了兩件事：
 *
 * 1. `force-dynamic`——route segment 設定只有 server component 讀得到，
 *    寫在 "use client" 檔案裡不會生效。
 * 2. `<Suspense>`——`useSearchParams()` 在靜態產生階段會丟例外，
 *    沒有這層邊界的話 `npm run build` 會在 prerender /admin/login 時失敗。
 *    （實際踩到過，錯誤訊息只說 prerender-error，看不出是 searchParams 造成的。）
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "登入｜活動後台", robots: { index: false, follow: false } };

export default function AdminLoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
