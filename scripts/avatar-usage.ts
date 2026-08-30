/**
 * 虛擬人串流的用量報表。
 *
 * 🔴 這支存在的理由：`closeSession()` 一直寫在帳本裡，但沒有任何地方呼叫它——
 * 沒有 API 端點，瀏覽器也不會通知。實測正式站 88 個 session 裡，
 * `billed_minutes` 有值的是 0 個。帳本記得到「開了幾個」，記不到「用了幾分鐘」，
 * 而後者才是帳單上的數字。要省錢的第一步是看得到。
 *
 * ⚠️ 報表刻意把「真實訊號」與「以上限估算」分開列，不要合成一個數字。
 * 殭屍 session 的真實時長是**不知道**的：訪客關掉分頁之後 WebRTC 幾秒內就斷，
 * 但我們觀察不到那一刻。把估算值當實測值用，會讓人以為自己知道成本。
 *
 * 用法：
 *   npm run avatar:usage            只看報表
 *   npm run avatar:usage -- --settle  順手把逾時未結算的補上帳
 */
import { createAdminSupabase, hasSupabase } from "../lib/supabase";
import { readLimits, settleStaleSessions, isStale } from "../lib/avatar-ledger";

interface Row {
  id: string;
  started_at: string;
  ended_at: string | null;
  billed_minutes: number | null;
  max_seconds: number;
}

function bar(value: number, max: number, width = 28): string {
  if (max <= 0) return "";
  return "█".repeat(Math.max(0, Math.round((value / max) * width)));
}

async function main() {
  if (!hasSupabase()) {
    console.error("缺 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const limits = readLimits();

  if (process.argv.includes("--settle")) {
    let total = 0;
    // settleStaleSessions 一次最多處理 50 筆，累積的殭屍要跑到清空為止
    for (;;) {
      const n = await settleStaleSessions();
      total += n;
      if (n === 0) break;
    }
    console.log(`已補結算 ${total} 筆逾時未結算的 session\n`);
  }

  const db = createAdminSupabase();
  const { data, error } = await db
    .from("avatar_sessions")
    .select("id, started_at, ended_at, billed_minutes, max_seconds")
    .order("started_at", { ascending: true })
    .limit(5000);
  if (error) throw new Error(`讀取帳本失敗：${JSON.stringify(error)}`);
  const rows = (data ?? []) as Row[];

  if (!rows.length) {
    console.log("帳本還是空的。");
    return;
  }

  const now = Date.now();
  const real: Row[] = [];
  const estimated: Row[] = [];
  const open: Row[] = [];

  for (const r of rows) {
    if (!r.ended_at) {
      open.push(r);
      continue;
    }
    const seconds = (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000;
    // ⚠️ 剛好等於單次上限的，分不出是「以上限估算」還是「真的講滿」。
    // 兩者的計費金額一樣，但意義不同，所以歸在同一欄並在標題說清楚。
    if (seconds >= r.max_seconds) estimated.push(r);
    else real.push(r);
  }

  const minutesOf = (list: Row[]) =>
    list.reduce((s, r) => s + (r.billed_minutes ?? 0), 0);
  const avgSeconds = (list: Row[]) =>
    list.length
      ? list.reduce(
          (s, r) => s + (Date.parse(r.ended_at!) - Date.parse(r.started_at)) / 1000,
          0
        ) / list.length
      : 0;

  const openLive = open.filter(
    (r) => !isStale(Date.parse(r.started_at), now, limits.maxSessionSeconds)
  );

  console.log("═══ 虛擬人串流用量 ═══");
  console.log(
    `期間　${rows[0].started_at.slice(0, 10)} ~ ${rows[rows.length - 1].started_at.slice(0, 10)}` +
      `　共 ${rows.length} 個 session\n`
  );

  console.log("依結算方式：");
  console.log(
    `  有真實收線訊號　　${String(real.length).padStart(4)} 個　` +
      `${String(minutesOf(real)).padStart(4)} 分鐘　平均 ${avgSeconds(real).toFixed(0)} 秒`
  );
  console.log(
    `  以上限估算或講滿　${String(estimated.length).padStart(4)} 個　` +
      `${String(minutesOf(estimated)).padStart(4)} 分鐘　⚠️ 這是上限不是實測`
  );
  console.log(
    `  還沒結算　　　　　${String(open.length).padStart(4)} 個　` +
      `（其中 ${openLive.length} 個可能還活著）`
  );

  const settledMinutes = minutesOf(real) + minutesOf(estimated);
  const openUpper = open.length * Math.ceil(limits.maxSessionSeconds / 60);
  console.log(
    `\n合計　${settledMinutes} 分鐘已結算` +
      (open.length ? `，未結算最多再 ${openUpper} 分鐘` : "")
  );

  // 每日分佈：看得出流量集中在哪幾天，以及 autoStart 之後有沒有跳上去
  const byDay = new Map<string, { count: number; minutes: number }>();
  for (const r of rows) {
    const day = r.started_at.slice(0, 10);
    const cur = byDay.get(day) ?? { count: 0, minutes: 0 };
    cur.count += 1;
    cur.minutes += r.billed_minutes ?? Math.ceil(r.max_seconds / 60);
    byDay.set(day, cur);
  }
  const peak = Math.max(...Array.from(byDay.values(), (v) => v.minutes));
  console.log("\n每日（分鐘）：");
  for (const [day, v] of Array.from(byDay.entries())) {
    console.log(
      `  ${day}  ${String(v.minutes).padStart(4)} 分 / ${String(v.count).padStart(3)} 個  ${bar(v.minutes, peak)}`
    );
  }

  // 當月預算水位
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthMinutes = rows
    .filter((r) => Date.parse(r.started_at) >= monthStart.getTime())
    .reduce((s, r) => s + (r.billed_minutes ?? Math.ceil(r.max_seconds / 60)), 0);
  const pct = (monthMinutes / limits.monthlyMinuteBudget) * 100;
  console.log(
    `\n當月　${monthMinutes} / ${limits.monthlyMinuteBudget} 分鐘（${pct.toFixed(2)}%）` +
      `　單次上限 ${limits.maxSessionSeconds} 秒　並發上限 ${limits.maxConcurrent}`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
