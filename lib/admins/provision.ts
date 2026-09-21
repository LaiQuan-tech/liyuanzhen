import { createAdminSupabase, hasSupabase } from "../supabase";
import { requireManager } from "../admin-auth";

/**
 * 🔴 這是整個專案**唯一**碰 `auth.admin.*`（GoTrue Admin API）的檔案。
 *
 * 建立帳號、重設密碼、刪除帳號都只能經由 GoTrue 的 Admin API，而它需要
 * service_role 金鑰。
 *
 * （另一條路是直接 insert `auth.users`，但那要自己處理 bcrypt 雜湊、
 * `auth.identities` 那一列、以及 `aud`/`role`/`instance_id` 等 GoTrue 內部
 * 欄位。那些是平台的內部結構，不是公開契約——今天會動，某次 Supabase
 * 升級之後靜默壞掉。後台每天在用的登入不能建在那上面。）
 *
 * 這個檔案成立，靠的是三件事同時做到：
 *
 *   1. **每一支匯出的函式第一行都是 `await requireManager()`**，不倚賴呼叫端
 *      記得檢查。（代價是同一個請求裡會重複打 Auth 伺服器驗 session；
 *      這個站的人員管理是個位數頻率的操作，換掉「呼叫端漏寫一次就提權」
 *      這個風險很划算。）
 *   2. **只匯出具體動作，不匯出 client 本身。** 匯出 client 的話這個檔就變成
 *      一個通用的提權入口，任何人 import 進去就能對整個資料庫為所欲為。
 *   3. **完全不碰 `user_roles`。** 角色的授予在 `./index.ts`。
 *      兩件事混在一起，「建了帳號但授權失敗」時就沒辦法只回滾其中一半。
 *
 * ⚠️ 修改這個檔之前先想清楚：你是不是在把第 2 點打開。
 *
 * ⚠️ 這個專案沒有裝 `server-only` 套件，所以沒有那一道編譯期護欄。
 * 目前擋住「被 import 進 client component」的是 `requireManager()` 那條
 * import 鏈——它會拉進 `next/headers`，而那在 client component 裡會直接
 * build 失敗。那是可用的護欄，但它是副作用不是宣告；哪天 requireManager
 * 改得不再碰 next/headers，這裡就要補上 `import "server-only"`
 * （需要先 npm i server-only）。
 */

export type ProvisionResult =
  | { ok: true; userId: string; /** 這個 email 本來就有帳號，這次沒有新建。 */ existed: boolean }
  | { ok: false; message: string };

export type SimpleResult = { ok: true } | { ok: false; message: string };

/**
 * 這個 email 已經有 auth 帳號了嗎。
 *
 * ⚠️ 判斷寫在這裡一次，不要讓呼叫端各自比對英文訊息——GoTrue 換一次措辭
 * 就會有人漏改。
 */
function isEmailTaken(error: { message?: string; status?: number }): boolean {
  return /already been registered|already exists|duplicate/i.test(error.message ?? "");
}

/** GoTrue 的錯誤訊息是英文的，轉成後台看得懂的話。 */
function describe(error: { message?: string; status?: number }): string {
  const message = error.message ?? "";
  console.error("[admins/provision] GoTrue 失敗:", error.status, message);

  if (isEmailTaken(error)) {
    // 呼叫端會自己接手（找出既有帳號），所以這句話理論上看不到；
    // 留著是為了那條路也失敗時有話可說。
    return "這個電子信箱已經有帳號，但找不到它的編號。請聯絡開發者。";
  }
  if (/LAST_ADMIN/i.test(message)) {
    // 🔴 0006 的 keep_one_admin trigger。刪 auth 帳號會 cascade 掉 user_roles
    // 那一列，於是整個刪除連同 auth.users 一起 rollback。
    // ⚠️ GoTrue 會不會把這串原文透出來並不確定，所以呼叫端在動手之前
    // 也自己數一次人數。兩層都要有。
    return "系統至少要留一位管理員，這是最後一位，不能刪除或降級。";
  }
  if (/password/i.test(message)) {
    return `密碼不符合規則：${message}`;
  }
  if (/email/i.test(message)) {
    return `電子信箱有問題：${message}`;
  }
  return `帳號操作失敗（${error.status ?? "unknown"}），請截圖回報`;
}

/** ⚠️ 沒設 service_role 金鑰時要講清楚是哪一步沒做，不要讓 createAdminSupabase 丟出去。 */
function notConfigured(): { ok: false; message: string } {
  return {
    ok: false,
    message: "缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY，沒辦法管理帳號。",
  };
}

/**
 * 建立一個 auth 帳號。
 *
 * ⚠️ 這一支**只建帳號，不授予角色**。授予角色是呼叫端的事（`./index.ts`）。
 * 兩件事分開，service_role 的接觸面才停在「建帳號」這一步，而且
 * 「建了但沒授權」才有辦法乾淨地回滾。
 *
 * 🔴 `email_confirm: true` 不可省。
 * 這個站**沒有接任何寄信服務**，送不出確認信；不預先確認的話帳號建了
 * 也登不進去，而畫面上會顯示成「帳號建好了」——最難查的那種失敗。
 *
 * ⚠️ email 已經存在時**接手既有帳號，絕不改密碼**（回 existed: true）。
 * 那個帳號可能是先前被「移除權限」留下來的，也可能是別人正在用的；
 * 為了把人加回後台而重設別人的密碼，等於把他踢出去。
 */
export async function createAuthUser(
  email: string,
  password: string
): Promise<ProvisionResult> {
  await requireManager();
  if (!hasSupabase()) return notConfigured();

  const supabase = createAdminSupabase();
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error) {
    if (!isEmailTaken(error)) return { ok: false, message: describe(error) };

    // 已經有帳號了：找出它的編號接手，密碼維持原本那組。
    const existingId = await findAuthUserByEmail(email);
    if (!existingId) return { ok: false, message: describe(error) };
    return { ok: true, userId: existingId, existed: true };
  }

  if (!data.user?.id) {
    return { ok: false, message: "帳號建立後沒有拿到編號，請截圖回報" };
  }
  return { ok: true, userId: data.user.id, existed: false };
}

const PER_PAGE = 1000;
/**
 * 🔴 翻頁上限。
 *
 * GoTrue 的 admin API **沒有依 email 查詢的端點**（listUsers 只吃 page /
 * perPage），所以只能翻頁比對。上限訂在 20 頁 × 1000 筆：這個站的帳號是
 * 個位數，兩萬筆遠超過任何合理情況，而**沒有上限的迴圈遇到異常回應
 * （例如永遠回滿頁）就會變成一個打不完的請求**——後台會整個卡住。
 */
const MAX_PAGES = 20;

/** 依 email 找出既有的 auth 帳號。找不到回 null（不是丟例外）。 */
export async function findAuthUserByEmail(email: string): Promise<string | null> {
  await requireManager();
  if (!hasSupabase()) return null;

  const supabase = createAdminSupabase();
  const target = email.trim().toLowerCase();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) {
      console.error("[admins/provision] listUsers 失敗:", error.message);
      return null;
    }
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit.id;
    if (data.users.length < PER_PAGE) return null;
  }
  console.error(`[admins/provision] 翻過 ${MAX_PAGES} 頁仍未找到:`, target);
  return null;
}

/** 這個站的全部 auth 帳號。給人員列表補 email 與最後登入時間用。 */
export async function listAuthUsers(): Promise<
  { id: string; email: string | null; last_sign_in_at: string | null }[]
> {
  await requireManager();
  if (!hasSupabase()) return [];

  const supabase = createAdminSupabase();
  const out: { id: string; email: string | null; last_sign_in_at: string | null }[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) {
      console.error("[admins/provision] listUsers 失敗:", error.message);
      // ⚠️ 回已經拿到的部分，不要丟例外。這只是列表上的附加資訊，
      // 為了它讓整頁變成 500 不划算——少了 email 的那幾列會顯示成「—」。
      return out;
    }
    for (const u of data.users) {
      out.push({
        id: u.id,
        email: u.email ?? null,
        last_sign_in_at: u.last_sign_in_at ?? null,
      });
    }
    if (data.users.length < PER_PAGE) return out;
  }
  return out;
}

/** 重設某個人的密碼。帳號與角色都不動。 */
export async function setUserPassword(
  userId: string,
  password: string
): Promise<SimpleResult> {
  await requireManager();
  if (!hasSupabase()) return notConfigured();

  const supabase = createAdminSupabase();
  const { error } = await supabase.auth.admin.updateUserById(userId, { password });
  if (error) return { ok: false, message: describe(error) };
  return { ok: true };
}

/**
 * 刪除 auth 帳號。
 *
 * ⚠️ 不可逆，而且 `user_roles.user_id` 是 `on delete cascade`，角色那一列
 * 會跟著消失——所以呼叫端不需要（也不該）另外去刪 user_roles。
 *
 * ⚠️ 若這是最後一位管理員，0006 的 `keep_one_admin` trigger 會擋下那個
 * cascade delete，於是整個刪除（連同 auth.users）一起 rollback。那是刻意的：
 * 沒有管理員的後台沒有人救得回來。
 */
export async function deleteAuthUser(userId: string): Promise<SimpleResult> {
  await requireManager();
  if (!hasSupabase()) return notConfigured();

  const supabase = createAdminSupabase();
  const { error } = await supabase.auth.admin.deleteUser(userId);
  if (error) return { ok: false, message: describe(error) };
  return { ok: true };
}
