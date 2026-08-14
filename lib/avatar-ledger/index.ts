import { createAdminSupabase, hasSupabase } from "../supabase";
import {
  decideAdmission,
  isStale,
  billableMinutes,
  type AdmissionResult,
  type LedgerLimits,
  type LedgerSnapshot,
} from "./types";

export type {
  AdmissionResult,
  AdmissionDenial,
  LedgerLimits,
  LedgerSnapshot,
} from "./types";
export { decideAdmission, isStale, billableMinutes } from "./types";

/**
 * 預設值刻意保守。三個數字的理由：
 *
 * maxConcurrent 36    Scale 方案上限是 40，留 4 個緩衝給「已發 token 但還沒連上」
 *                     的空窗，以及我們算漏的殭屍。永遠不要讓請求打到 HeyGen 的
 *                     天花板，因為那一層沒有優雅的失敗。
 * monthlyMinuteBudget 一萬人各聊三分鐘。這是帳單的硬上限，不是預估——
 *                     到頂就停發新 token，當月剩下的時間只剩文字問答。
 * maxSessionSeconds 180  成本控制最有效的一根槓桿，而且對排隊的人來說流動更快。
 */
export function readLimits(): LedgerLimits {
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  return {
    maxConcurrent: num(process.env.AVATAR_MAX_CONCURRENT, 36),
    monthlyMinuteBudget: num(process.env.AVATAR_MONTHLY_MINUTES, 30_000),
    maxSessionSeconds: num(process.env.AVATAR_MAX_SESSION_SECONDS, 180),
    // 預設關閉：沒有明確打開之前，不會有任何人意外開始燒錢
    enabled: process.env.AVATAR_ENABLED === "true",
  };
}

/**
 * ⚠️ 沒有 Supabase 就直接拒絕，**不要**退回行程內計數。
 *
 * Vercel 是多實例的，行程內的計數每個實例各算各的——四個實例各以為自己只用了
 * 10 個並發，實際上是 40。那種「看起來有在管、其實沒在管」的閘門比沒有更危險，
 * 因為它會讓人以為成本受控。
 */
export async function checkAdmission(): Promise<AdmissionResult> {
  const limits = readLimits();
  if (!limits.enabled) {
    return { admit: false, reason: "disabled", queueAhead: 0 };
  }
  if (!hasSupabase()) {
    console.error("[avatar-ledger] 沒有 Supabase 憑證，拒絕發放 session");
    return { admit: false, reason: "disabled", queueAhead: 0 };
  }

  const snapshot = await readSnapshot(limits);
  return decideAdmission(snapshot, limits);
}

async function readSnapshot(limits: LedgerLimits): Promise<LedgerSnapshot> {
  const db = createAdminSupabase();
  const now = Date.now();

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  // 只撈可能還活著的：起始時間在「單次上限 + 緩衝」之內的。
  // 更早的一律是殭屍，不用撈回來判斷。
  const liveWindowMs = (limits.maxSessionSeconds + 30) * 1000;
  const [openRows, monthRows] = await Promise.all([
    db
      .from("avatar_sessions")
      .select("started_at")
      .is("ended_at", null)
      .gte("started_at", new Date(now - liveWindowMs).toISOString()),
    db
      .from("avatar_sessions")
      .select("billed_minutes, started_at, max_seconds")
      .gte("started_at", monthStart.toISOString()),
  ]);

  if (openRows.error) throw openRows.error;
  if (monthRows.error) throw monthRows.error;

  const activeSessions = (openRows.data ?? []).filter(
    (r) => !isStale(Date.parse(r.started_at), now, limits.maxSessionSeconds)
  ).length;

  // 還沒結算的列（進行中或殭屍）也要算進預算，否則尖峰時會嚴重低估——
  // 那正是最需要閘門生效的時刻。未結算的一律以單次上限估算。
  const monthMinutesUsed = (monthRows.data ?? []).reduce((sum, r) => {
    if (typeof r.billed_minutes === "number") return sum + r.billed_minutes;
    return sum + Math.ceil((r.max_seconds ?? limits.maxSessionSeconds) / 60);
  }, 0);

  return { activeSessions, monthMinutesUsed };
}

/** 發出 token 的當下就記一筆，不要等連線建立——那段空窗也要算進並發。 */
export async function openSession(
  sessionId: string,
  clientHash: string | null,
  maxSeconds: number
): Promise<void> {
  const db = createAdminSupabase();
  const { error } = await db.from("avatar_sessions").insert({
    id: sessionId,
    client_hash: clientHash,
    max_seconds: maxSeconds,
  });
  if (error) throw error;
}

/**
 * 收到關閉訊號時結算。收不到也沒關係——`isStale` 會用時間判定，
 * 而未結算的列在預算計算裡是以單次上限估算的，不會低估。
 */
export async function closeSession(sessionId: string): Promise<void> {
  const db = createAdminSupabase();
  const { data, error } = await db
    .from("avatar_sessions")
    .select("started_at, max_seconds, ended_at")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) throw error;
  if (!data || data.ended_at) return; // 沒這筆或已結算過，冪等

  const startedAt = Date.parse(data.started_at);
  const endedAt = Date.now();

  await db
    .from("avatar_sessions")
    .update({
      ended_at: new Date(endedAt).toISOString(),
      billed_minutes: billableMinutes(startedAt, endedAt, data.max_seconds),
    })
    .eq("id", sessionId);
}
