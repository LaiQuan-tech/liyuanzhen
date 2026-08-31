import { NextResponse, type NextRequest } from "next/server";
import { createAuthServerClient, hasAuthCredentials } from "@/lib/supabase-auth";

/**
 * 後台的 session 續期與導向。
 *
 * 🔴 **這不是權限防線。** 它只做兩件事：
 *   1. 讓 Supabase 的 session cookie 保持新鮮（不做的話使用者會莫名被登出）
 *   2. 沒登入就把 /admin/* 導去登入頁——那是體驗，不是安全
 *
 * 真正的閘門在 `lib/admin-auth.ts` 的 `requireAdmin()`，而且**每一支會改資料的
 * server action 都要自己呼叫一次**。server action 可以被直接呼叫，繞得過這裡。
 *
 * ⚠️ 這裡刻意**不查 has_role**。middleware 跑在每一個 /admin 請求上，
 * 多一次資料庫往返會讓整個後台變慢；而且它擋不住的東西，查了也還是擋不住。
 */
export async function middleware(request: NextRequest) {
  // 沒設 anon key 時直接放行到頁面，讓頁面自己顯示「尚未設定」——
  // 在 middleware 丟例外會讓整站 500，連公開頁都打不開。
  if (!hasAuthCredentials()) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createAuthServerClient({
    getAll: () => request.cookies.getAll(),
    setAll: (list) => {
      // ⚠️ 兩邊都要寫：request 那份給後續的 server component 讀，
      // response 那份才會真的回到瀏覽器。只寫一邊的症狀是「登入之後
      // 第一次導頁又被踢回登入頁」。
      for (const c of list) request.cookies.set(c.name, c.value);
      response = NextResponse.next({ request });
      for (const c of list) response.cookies.set(c.name, c.value, c.options);
    },
  });

  // ⚠️ 一定要呼叫 getUser()。它是讓 @supabase/ssr 真的去續期 token 的動作，
  // 拿掉之後 cookie 不會被更新，使用者過一段時間就會被登出。
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isLoginPage = path === "/admin/login";

  if (!user && path.startsWith("/admin") && !isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin/login";
    // 登入後回到原本要去的地方，不要一律丟回總覽
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  if (user && isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // 只跑 /admin，不要拖累公開頁。
  // ⚠️ 公開頁（首頁、/live、/chat）完全不需要 session，把它們納進來
  // 等於每一次瀏覽都多打一次 Auth 伺服器。
  matcher: ["/admin/:path*"],
};
