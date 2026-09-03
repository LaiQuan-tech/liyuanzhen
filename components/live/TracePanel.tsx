"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { onTrace, traceEntries, traceServerSnapshot } from "@/lib/trace";

/**
 * 現場診斷面板。加 `?debug=1` 才會出現。
 *
 * ⚠️ 這不是開發者的方便工具，是**回報管道**。
 * 「按住說話沒反應」被修了五輪還在發生，唯一的原因是這條鏈路有八段，
 * 而八段全部失敗的畫面長得一模一樣：一張不動的臉。
 * 有了這個面板，回報從「還是一樣」變成一張寫著
 * 「+700ms 第一塊音訊逾時」或「+8200ms /api/chat 回應 HTTP 429」的截圖。
 *
 * ⚠️ 預設關閉、不留任何佔位。這是一個給不特定大眾看的基金會網站，
 * 不能因為工程需要就在正式頁面上長出一塊除錯區。
 */
export default function TracePanel() {
  const entries = useSyncExternalStore(onTrace, traceEntries, traceServerSnapshot);

  // ⚠️ 要在 effect 裡讀 location，不可以在 render 期間讀——
  // 伺服器端沒有 window，直接讀會 hydration mismatch。
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    setEnabled(new URLSearchParams(window.location.search).has("debug"));
  }, []);

  if (!enabled) return null;

  return (
    <div className="pointer-events-none absolute inset-y-0 left-0 z-30 flex w-full max-w-md flex-col justify-end p-3 sm:p-4">
      <div className="pointer-events-auto max-h-[45vh] overflow-y-auto rounded-xl bg-black/80 p-3 font-mono text-[11px] leading-relaxed text-white/85 backdrop-blur-sm">
        <div className="mb-1.5 font-bold text-white/50">
          現場紀錄（網址去掉 ?debug=1 就不會出現）
        </div>
        {entries.length === 0 ? (
          <div className="text-white/40">點一下說話之後，這裡會逐條記錄每一段。</div>
        ) : (
          entries.map((entry, i) => (
            <div
              key={i}
              className={
                entry.level === "error"
                  ? "text-red-300"
                  : entry.level === "warn"
                    ? "text-amber-300"
                    : "text-white/85"
              }
            >
              {/* 毫秒靠右對齊，掃一眼就看得出哪一段花了多久 */}
              <span className="mr-2 tabular-nums text-white/40">
                +{String(entry.at).padStart(5, " ")}ms
              </span>
              {entry.label}
              {entry.detail ? <span className="text-white/55"> — {entry.detail}</span> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
