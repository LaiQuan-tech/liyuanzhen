import Link from "next/link";
import { requireManager, NotManagerError } from "@/lib/admin-auth";
import ManagerOnlyNotice from "@/components/admin/ManagerOnlyNotice";
import {
  listAudit,
  parseEntityFilter,
  parsePage,
  totalPages,
  actorLabel,
  targetLabel,
  actionLabel,
  entityLabel,
  formatAuditTime,
  ENTITY_FILTER_LABEL,
  PAGE_SIZE,
  MissingTableError,
} from "@/lib/audit";
import type { AuditEntityFilter } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const metadata = { title: "操作日誌｜活動後台" };

/**
 * 誰在什麼時候對哪一筆做了什麼。
 *
 * 🔴 第一行的 `requireManager()` 才是守門。側邊欄對小編不渲染這個項目，
 * 但那只是畫面——知道網址就打得到。
 *
 * ⚠️ 這一頁用 server component 的 `searchParams` prop 讀 ?page= 與 ?entity=，
 * **不是** `useSearchParams()`。後者需要拆 client 元件 ＋ <Suspense>，
 * 否則 npm run build 會在 prerender 階段失敗（/admin/login 踩過一模一樣的坑）。
 *
 * ⚠️ 篩選用 `<Link>` 帶 query 而不是下拉選單 ＋ JS，這樣網址本身就是狀態：
 * 「你看一下 /admin/logs?entity=admin」可以直接貼給人。
 */

const FILTERS: AuditEntityFilter[] = ["all", "event", "admin"];

export default async function LogsPage({
  searchParams,
}: {
  searchParams: { entity?: string; page?: string };
}) {
  try {
    await requireManager();
  } catch (error) {
    if (error instanceof NotManagerError) return <ManagerOnlyNotice what="操作日誌" />;
    throw error;
  }

  const filter = parseEntityFilter(searchParams.entity);
  const requestedPage = parsePage(searchParams.page);

  let data;
  try {
    data = await listAudit(filter, requestedPage);
  } catch (error) {
    // 🔴 資料表還沒建立時要講清楚是哪一步沒做。
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
            在那之前的操作<strong>不會</strong>被補記——日誌是從那份 SQL 跑完那一刻才開始的。
          </p>
        </div>
      );
    }
    throw error;
  }

  // ⚠️ 用資料層回傳的 page，不是網址上要求的那個。
  // ?page=99 會被夾成最後一頁，這裡顯示原本要求的值就會寫出「第 99 / 2 頁」。
  const { rows, total, counts, page } = data;
  const pages = totalPages(total);

  return (
    <>
      <div>
        <h1 className="font-display text-[20px] font-extrabold">操作日誌</h1>
        <p className="mt-1 text-[13.5px] text-muted">
          誰在什麼時候對哪一筆做了什麼。共 {counts.all} 筆
        </p>
      </div>

      {/*
        🔴 只記「做了什麼」，不記「改成什麼」。
        存前後值的 diff 會把報名者的姓名、email、電話複製一份進這張
        append-only、所有管理員都看得到的表裡。那是隱私的倒退。
      */}
      <p className="mt-4 rounded-lg bg-brand-wash px-4 py-2.5 text-[12.5px] leading-relaxed text-ink-soft">
        這裡只記「誰、什麼時候、對哪一筆、做了什麼」，
        <strong>不記錄修改前後的內容</strong>
        ——場次底下掛著報名者的姓名與電話，存進日誌就等於把個資多複製一份到一張刪不掉的表裡。
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const n = counts[f];
          const active = f === filter;
          return (
            <Link
              key={f}
              // 換篩選一定要回第 1 頁，否則會停在一個新條件下不存在的頁數上
              href={f === "all" ? "/admin/logs" : `/admin/logs?entity=${f}`}
              className={`rounded-full px-3.5 py-1.5 text-[13.5px] font-bold ${
                active ? "bg-brand-wash text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {ENTITY_FILTER_LABEL[f]} {n}
            </Link>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <p className="mt-10 text-[14.5px] text-muted">
          {counts.all === 0
            ? "還沒有任何紀錄。下一次在後台做的事就會出現在這裡。"
            : "這個條件下沒有紀錄，換一個篩選看看。"}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-[14px]">
            <thead>
              <tr className="border-b-[1.5px] border-ink/20 text-left">
                <th className="py-2 pr-4 font-bold">時間</th>
                <th className="py-2 pr-4 font-bold">操作者</th>
                <th className="py-2 pr-4 font-bold">動作</th>
                <th className="py-2 pr-4 font-bold">項目</th>
                <th className="py-2 font-bold">名稱</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-ink/10 align-top">
                  <td className="whitespace-nowrap py-2.5 pr-4 text-[12.5px] tabular-nums text-muted">
                    {formatAuditTime(r.created_at)}
                  </td>
                  {/* 帳號被刪掉之後仍然看得出是誰做的——存的是快照不是外鍵 */}
                  <td className="py-2.5 pr-4 text-[13px] break-all">{actorLabel(r)}</td>
                  <td className="whitespace-nowrap py-2.5 pr-4 text-[13px]">
                    {actionLabel(r.action)}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-4 text-[13px] text-muted">
                    {entityLabel(r.entity)}
                  </td>
                  <td className="py-2.5 text-[13px]">{targetLabel(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav className="mt-8 flex items-center justify-between gap-4 text-[13.5px]">
          <PageLink filter={filter} page={page - 1} disabled={page <= 1}>
            ← 上一頁
          </PageLink>
          <span className="text-muted">
            第 {page} / {pages} 頁　每頁 {PAGE_SIZE} 筆
          </span>
          <PageLink filter={filter} page={page + 1} disabled={page >= pages}>
            下一頁 →
          </PageLink>
        </nav>
      )}

      {/*
        🔴 誠實寫出已知缺口。
        一份看起來很完整、實際上有洞的稽核日誌，比一份標明了洞的更危險——
        因為它會讓人以為「日誌裡沒有就是沒發生」。
      */}
      <section className="mt-12 border-t border-ink/10 pt-6">
        <h2 className="text-[14px] font-bold">這份日誌看不到的事</h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[12.5px] leading-relaxed text-muted">
          <li>
            直接在 Supabase Dashboard 改資料<strong>不會留下紀錄</strong>。
            這份日誌是後台的程式碼自己寫的，繞過後台的操作它看不到。
          </li>
          <li>
            <strong>「誰匯出了報名名單」記錄不到。</strong>
            匯出的按鈕（<code className="text-[12px]">components/admin/CsvButton.tsx</code>
            ）是在瀏覽器端把已經在畫面上的資料組成檔案，伺服器完全不知道匯出發生了。
            而「誰把名單帶走了」恰恰是稽核日誌最會被問到的問題——要補上它，
            得先把匯出改成一支伺服器端的端點。
          </li>
          <li>紀錄只有「做了什麼」，沒有「改成什麼」。那是刻意的，理由見上面那段。</li>
        </ul>
      </section>
    </>
  );
}

function PageLink({
  filter,
  page,
  disabled,
  children,
}: {
  filter: AuditEntityFilter;
  page: number;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return <span className="text-muted-light">{children}</span>;
  }
  const params = new URLSearchParams();
  if (filter !== "all") params.set("entity", filter);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return (
    <Link
      href={query ? `/admin/logs?${query}` : "/admin/logs"}
      className="font-bold underline-offset-4 hover:underline"
    >
      {children}
    </Link>
  );
}
