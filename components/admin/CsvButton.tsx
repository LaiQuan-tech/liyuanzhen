"use client";

/**
 * 把畫面上的表格存成 CSV。報名名單與問答紀錄共用。
 *
 * ⚠️ 在瀏覽器端組檔案，不做成 API 端點。多一支會回傳個資的 GET 端點，
 * 就多一個要守的地方；資料已經在這一頁的畫面上了，沒有必要再繞一趟伺服器。
 *
 * ⚠️ 一定要加 BOM。沒有 BOM 的 UTF-8 CSV 在 Excel（尤其是 Windows 版）
 * 開起來中文全部是亂碼——而收到檔案的人多半就是用 Excel 開。
 *
 * 🔴 這個作法的前提是**整份資料已經在 props 裡**。呼叫端如果有分頁，
 * 匯出的就只有當前那一頁——那不是 bug，但一定要在 `label` 裡講明白，
 * 否則使用者會以為手上那份 CSV 是全部。
 */
export default function CsvButton({
  filename,
  rows,
  label = "匯出 CSV",
}: {
  filename: string;
  rows: Record<string, string>[];
  label?: string;
}) {
  const download = () => {
    if (rows.length === 0) return;

    // 逗號、雙引號、換行都要處理。雙引號的跳脫方式是重複一次，不是反斜線。
    const cell = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = Object.keys(rows[0]);
    const body = rows.map((r) => header.map((h) => cell(r[h])).join(","));
    const csv = "﻿" + [header.map(cell).join(","), ...body].join("\r\n");

    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    // ⚠️ 要 revoke，不然這個 blob 會一直佔著記憶體直到分頁關掉
    URL.revokeObjectURL(url);
  };

  return (
    <button
      type="button"
      onClick={download}
      disabled={rows.length === 0}
      className="rounded-lg border-[1.5px] border-ink/25 px-3 py-1.5 text-[13.5px] font-bold hover:border-ink disabled:opacity-40"
    >
      {label}
    </button>
  );
}
