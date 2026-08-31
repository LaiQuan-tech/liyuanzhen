import Link from "next/link";
import CsvButton from "@/components/admin/CsvButton";
import {
  listInteractions,
  classifyInteraction,
  parseFilter,
  parsePage,
  totalPages,
  channelLabel,
  shortSession,
  formatTimestamp,
  formatSimilarity,
  STATUS_LABEL,
  FILTER_LABEL,
  PAGE_SIZE,
  MissingSchemaError,
} from "@/lib/interactions";
import type { InteractionFilter, InteractionStatus } from "@/lib/interactions";

export const dynamic = "force-dynamic";
export const metadata = { title: "問答紀錄｜活動後台" };

/**
 * 訪客問了什麼、數位人答了什麼。
 *
 * ⚠️ 這一頁用 server component 的 `searchParams` prop 讀 ?page= 與 ?filter=，
 * **不是** `useSearchParams()`。後者需要拆 client 元件 ＋ <Suspense>，
 * 否則 npm run build 會在 prerender 階段失敗（/admin/login 踩過一模一樣的坑）。
 */

const BADGE: Record<InteractionStatus, string> = {
  ok: "bg-ok/10 text-ok",
  "out-of-scope": "bg-ink/10 text-ink-soft",
  blocked: "bg-plum-wash text-plum",
  failed: "bg-wine-wash text-wine",
};

const FILTERS: InteractionFilter[] = ["all", "unanswered", "failed"];

export default async function InteractionsPage({
  searchParams,
}: {
  searchParams: { filter?: string; page?: string };
}) {
  const filter = parseFilter(searchParams.filter);
  const requestedPage = parsePage(searchParams.page);

  let data;
  try {
    data = await listInteractions(filter, requestedPage);
  } catch (error) {
    // 🔴 欄位還沒建立時要講清楚是哪一步沒做。變成 500 的話畫面上只有
    // "Application error"，而真正該做的動作（去跑那份 SQL）完全看不出來。
    if (error instanceof MissingSchemaError) {
      return (
        <div className="max-w-xl">
          <h1 className="font-display text-[20px] font-extrabold">欄位還沒建立</h1>
          <p className="mt-3 text-[14.5px] leading-relaxed text-ink-soft">
            請把{" "}
            <code className="text-[13px]">
              supabase/migrations/0005_interactions_admin.sql
            </code>{" "}
            貼到 Supabase Dashboard 的 SQL Editor 跑一次，然後重新整理這一頁。
          </p>
          <p className="mt-3 text-[13.5px] text-muted">
            那份 SQL 會補上 <code className="text-[13px]">failed</code> 與{" "}
            <code className="text-[13px]">channel</code> 兩個欄位，並把既有的當機紀錄標記起來。
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

  const csvRows = rows.map((r) => ({
    時間: formatTimestamp(r.created_at),
    來源: channelLabel(r.channel),
    問題: r.question_text,
    回答: r.answer_summary,
    狀態: STATUS_LABEL[classifyInteraction(r)],
    相似度: formatSimilarity(r.top_similarity),
    造訪代號: shortSession(r.session_id),
  }));

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="font-display text-[20px] font-extrabold">問答紀錄</h1>
          <p className="mt-1 text-[13.5px] text-muted">
            訪客問了什麼、數位人怎麼回答。共 {counts.all} 筆
            {counts.failed > 0 && <>，其中 {counts.failed} 筆系統出錯</>}
          </p>
        </div>
        {/*
          ⚠️ 明寫「這一頁」。CsvButton 用的是這一頁 props 裡的資料，
          分頁之後匯出的就只有當前這一頁——不講清楚的話，
          拿到檔案的人會以為那是全部。
        */}
        <CsvButton
          filename={`問答紀錄-${filter}-第${page}頁.csv`}
          rows={csvRows}
          label={`匯出這一頁（${rows.length} 筆）`}
        />
      </div>

      {/*
        ⚠️ 提問是自由文字。這一頁沒有 IP、沒有姓名欄位（資料表裡根本沒存），
        但訪客可能自己在問題裡打了電話或住址——那比報名名單更難預測。
      */}
      <p className="mt-4 rounded-lg bg-brand-wash px-4 py-2.5 text-[12.5px] leading-relaxed text-ink-soft">
        這些是真人打進來的原始文字。訪客有可能在提問裡寫了自己的電話或住址，
        請不要投影、截圖轉傳，或匯出後放在共用資料夾。
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const n = f === "all" ? counts.all : f === "unanswered" ? counts.unanswered : counts.failed;
          const active = f === filter;
          return (
            <Link
              key={f}
              // 換篩選一定要回第 1 頁，否則會停在一個新條件下不存在的頁數上
              href={f === "all" ? "/admin/interactions" : `/admin/interactions?filter=${f}`}
              className={`rounded-full px-3.5 py-1.5 text-[13.5px] font-bold ${
                active ? "bg-brand-wash text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {FILTER_LABEL[f]} {n}
            </Link>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <p className="mt-10 text-[14.5px] text-muted">
          {counts.all === 0
            ? "還沒有任何問答紀錄。"
            : "這個條件下沒有紀錄，換一個篩選看看。"}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-[14px]">
            <thead>
              <tr className="border-b-[1.5px] border-ink/20 text-left">
                <th className="py-2 pr-4 font-bold">時間</th>
                <th className="py-2 pr-4 font-bold">來源</th>
                <th className="py-2 pr-4 font-bold">問題</th>
                <th className="py-2 pr-4 font-bold">數位人的回答</th>
                <th className="py-2 pr-4 font-bold">狀態</th>
                <th className="py-2 font-bold">相似度</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const status = classifyInteraction(r);
                // 同一次造訪的追問排在一起，用比較淡的分隔線群組起來。
                const sameVisit = i > 0 && rows[i - 1].session_id === r.session_id;
                return (
                  <tr
                    key={r.id}
                    className={`align-top ${
                      sameVisit ? "border-b border-ink/[0.06]" : "border-b border-ink/15"
                    }`}
                  >
                    <td className="py-2.5 pr-4 text-[12.5px] tabular-nums text-muted">
                      {sameVisit ? (
                        <span className="text-muted-light">↳ 同一次造訪</span>
                      ) : (
                        formatTimestamp(r.created_at)
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-[13px] text-muted">
                      {channelLabel(r.channel)}
                    </td>
                    <td className="max-w-[22rem] py-2.5 pr-4">{r.question_text}</td>
                    <td className="max-w-[26rem] py-2.5 pr-4 text-[13px] text-ink-soft">
                      {r.answer_summary}
                    </td>
                    <td className="py-2.5 pr-4">
                      <span
                        className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11.5px] font-bold ${BADGE[status]}`}
                      >
                        {STATUS_LABEL[status]}
                      </span>
                    </td>
                    <td className="py-2.5 text-[12.5px] tabular-nums text-muted">
                      {formatSimilarity(r.top_similarity)}
                    </td>
                  </tr>
                );
              })}
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
    </>
  );
}

function PageLink({
  filter,
  page,
  disabled,
  children,
}: {
  filter: InteractionFilter;
  page: number;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return <span className="text-muted-light">{children}</span>;
  }
  const params = new URLSearchParams();
  if (filter !== "all") params.set("filter", filter);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return (
    <Link
      href={query ? `/admin/interactions?${query}` : "/admin/interactions"}
      className="font-bold underline-offset-4 hover:underline"
    >
      {children}
    </Link>
  );
}
