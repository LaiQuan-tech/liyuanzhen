import type { User } from "@supabase/supabase-js";
import { requireManager, NotManagerError } from "@/lib/admin-auth";
import ManagerOnlyNotice from "@/components/admin/ManagerOnlyNotice";
import { listAdmins, MissingTableError, ROLE_LABEL, ROLE_HINT } from "@/lib/admins";
import type { AdminRole } from "@/lib/admins";
import { formatAuditTime } from "@/lib/audit";
import AdminForm from "./AdminForm";
import RowActions from "./RowActions";

export const dynamic = "force-dynamic";
export const metadata = { title: "後台人員｜活動後台" };

/**
 * 誰可以進後台、各自是什麼層級。
 *
 * 🔴 第一行的 `requireManager()` 才是守門。
 * 側邊欄對小編不渲染這個項目，但那只是畫面——知道網址就打得到。
 *
 * ⚠️ 這一頁用 server component，沒有 `useSearchParams()`（那需要拆
 * client 元件 ＋ <Suspense>，否則 npm run build 會在 prerender 階段失敗）。
 */

const ROLE_BADGE: Record<AdminRole, string> = {
  admin: "bg-violet text-white",
  editor: "bg-ink/10 text-ink-soft",
};

export default async function AdminsPage() {
  let actor: User;
  try {
    actor = await requireManager();
  } catch (error) {
    if (error instanceof NotManagerError) return <ManagerOnlyNotice what="後台人員管理" />;
    throw error;
  }

  let rows;
  try {
    rows = await listAdmins();
  } catch (error) {
    // 🔴 資料表還沒建立時要講清楚是哪一步沒做。變成 500 的話畫面上只有
    // "Application error"，而真正該做的動作（去跑那份 SQL）完全看不出來。
    if (error instanceof MissingTableError) {
      return (
        <div className="max-w-xl">
          <h1 className="font-display text-[20px] font-extrabold">資料表還沒建立</h1>
          <p className="mt-3 text-[14.5px] leading-relaxed text-ink-soft">
            請把{" "}
            <code className="text-[13px]">
              supabase/migrations/0006_admin_users_and_audit.sql
            </code>{" "}
            貼到 Supabase Dashboard 的 SQL Editor 跑一次，然後重新整理這一頁。
          </p>
          <p className="mt-3 text-[13.5px] text-muted">
            那份 SQL 會加上「小編」這個層級、建立操作日誌，並補上「至少留一位管理員」的保護。
          </p>
        </div>
      );
    }
    throw error;
  }

  const managerCount = rows.filter((r) => r.role === "admin").length;

  return (
    <>
      <div>
        <h1 className="font-display text-[20px] font-extrabold">後台人員</h1>
        <p className="mt-1 text-[13.5px] text-muted">
          共 {rows.length} 位，其中 {managerCount} 位管理員。
        </p>
      </div>

      <p className="mt-4 rounded-lg bg-brand-wash px-4 py-2.5 text-[12.5px] leading-relaxed text-ink-soft">
        <strong>{ROLE_LABEL.admin}</strong>：{ROLE_HINT.admin}
        <br />
        <strong>{ROLE_LABEL.editor}</strong>：{ROLE_HINT.editor}
        <br />
        這一頁的每一個操作都會記進「操作日誌」。
      </p>

      {rows.length === 0 ? (
        <p className="mt-8 text-[14.5px] text-muted">
          名冊是空的。理論上不會發生——你自己就該在裡面，而你正在看這一頁。
          請確認 0006 的 SQL 跑完了。
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-[14px]">
            <thead>
              <tr className="border-b-[1.5px] border-ink/20 text-left">
                <th className="py-2 pr-4 font-bold">電子信箱</th>
                <th className="py-2 pr-4 font-bold">層級</th>
                <th className="py-2 pr-4 font-bold">加入時間</th>
                <th className="py-2 pr-4 font-bold">最後登入</th>
                <th className="py-2 font-bold">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.user_id} className="border-b border-ink/10 align-top">
                  <td className="py-3 pr-4 break-all">{row.email ?? "（查不到信箱）"}</td>
                  <td className="py-3 pr-4">
                    <span
                      className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11.5px] font-bold ${ROLE_BADGE[row.role]}`}
                    >
                      {ROLE_LABEL[row.role]}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-[12.5px] tabular-nums text-muted">
                    {formatAuditTime(row.created_at)}
                  </td>
                  {/*
                    「密碼給出去了，對方到底有沒有用」——從來沒登入過的人
                    多半是密碼沒轉達到，或是他根本沒收到通知。
                  */}
                  <td className="py-3 pr-4 text-[12.5px] tabular-nums text-muted">
                    {row.last_sign_in_at ? formatAuditTime(row.last_sign_in_at) : "從未登入"}
                  </td>
                  <td className="py-3">
                    <RowActions
                      userId={row.user_id}
                      email={row.email ?? row.user_id}
                      role={row.role}
                      isSelf={row.user_id === actor.id}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-12 border-t border-ink/10 pt-8">
        <h2 className="font-display text-[17px] font-extrabold">新增人員</h2>
        <p className="mt-1 text-[13.5px] leading-relaxed text-muted">
          這個站沒有接寄信服務，所以<strong>沒有邀請信這條路</strong>：密碼由你在這裡直接設定，
          再當面或用電話交給對方。對方登入後可以自己在 Supabase 改，但這個後台沒有
          「改自己的密碼」的介面。
        </p>
        <AdminForm />
      </div>
    </>
  );
}
