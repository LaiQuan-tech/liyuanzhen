/**
 * 一輪語音問答的現場紀錄。
 *
 * ⚠️ 這個檔案存在的理由，是「按住說話沒反應」被修了五輪還在發生。
 *
 * 每一輪的診斷都長這樣：使用者回報「還是一樣」→ 我讀程式碼 → 找到一個
 * 看起來說得通的 bug → 修掉 → 部署 → 使用者回報「還是一樣」。
 * 五次裡面沒有一次我看得到現場，因為這條鏈路有八段（手勢 → getUserMedia →
 * AudioContext → worklet → WAV → /api/stt → /api/chat → /api/tts → avatar），
 * 而**八段全部失敗的畫面長得一模一樣**：一張不動的臉，什麼都沒發生。
 *
 * 沒有這個模組，回報只能是「沒反應」；有了它，回報是一張截圖，
 * 上面寫著第幾毫秒卡在哪一段。修東西之前先讓它會講話，比再猜一次便宜。
 *
 * 純模組層狀態、只在瀏覽器跑。不進任何判斷邏輯——它只負責記錄與顯示。
 */

export interface TraceEntry {
  /** 距離這一輪開始的毫秒數 */
  at: number;
  label: string;
  detail?: string;
  level: "info" | "warn" | "error";
}

/** 一輪最多留幾筆。超過就丟最舊的——卡住的那一段一定在後面。 */
const MAX_ENTRIES = 60;

/** ⚠️ 空陣列要是**同一個**參照，否則 useSyncExternalStore 會判定每次都變了而無限重繪。 */
const EMPTY: readonly TraceEntry[] = [];

let origin = 0;
let entries: readonly TraceEntry[] = EMPTY;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => fn());
}

/** 新的一輪。⚠️ 在 press() 裡呼叫，時間原點才會對齊使用者按下去的那一刻。 */
export function traceReset(): void {
  origin = Date.now();
  entries = EMPTY;
  notify();
}

export function trace(label: string, detail?: string, level: TraceEntry["level"] = "info"): void {
  if (typeof window === "undefined") return;
  if (!origin) origin = Date.now();
  const at = Date.now() - origin;

  // ⚠️ 一定要產生新陣列。useSyncExternalStore 用 Object.is 比對快照，
  // 原地 push 的話畫面永遠不會更新。
  const next = entries.length >= MAX_ENTRIES ? entries.slice(1) : entries.slice();
  entries = [...next, { at, label, detail, level }];

  // console 也留一份：debug 面板沒開的時候，這是唯一的紀錄。
  const line = `[live +${at}ms] ${label}${detail ? ` — ${detail}` : ""}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);

  notify();
}

export function traceEntries(): readonly TraceEntry[] {
  return entries;
}

/** SSR 快照。⚠️ 必須回傳常數，回 [] 字面值會讓 React 每次 render 都認為變了。 */
export function traceServerSnapshot(): readonly TraceEntry[] {
  return EMPTY;
}

export function onTrace(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
