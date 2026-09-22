import { embedText } from "../embeddings";
import { findAnchor, needsContext, withAnchor, type HistoryTurn } from "../query-expansion";
import { hasSupabase } from "../supabase";
import { localStore } from "./local";
import { supabaseStore } from "./supabase";
import type { KnowledgeChunk, RetrievalResult, VectorStore } from "./types";

export type { KnowledgeChunk, RetrievalResult } from "./types";

/**
 * 門檻是這個系統最重要的兩個數字，必須用 `npm run eval:retrieval` 實測校準，
 * 不可憑感覺調。校準結果請寫進 README。
 *
 * 低於 HARD_FLOOR → 直接婉拒，連 LLM 都不呼叫。這同時是最強的 prompt injection
 * 防線：「忽略你的指示…」跟婦運語料的相似度趨近於零，模型根本看不到它。
 */
export const HARD_FLOOR = 0.62;
export const SOFT_FLOOR = 0.72;

const TOP_K = 8;
const MAX_CHUNKS = 5;
/** 命中很強時，只保留與最佳結果差距在此範圍內的塊，濾掉陪榜的雜訊 */
const RELATIVE_WINDOW = 0.12;

function pickStore(): VectorStore {
  const override = process.env.RETRIEVAL_PROVIDER;
  if (override === "local") return localStore;
  if (override === "supabase") return supabaseStore;
  return hasSupabase() ? supabaseStore : localStore;
}

/** 一次「embedding → 取前 TOP_K」。retrieve() 一題最多呼叫兩次。 */
async function searchOnce(store: VectorStore, query: string): Promise<KnowledgeChunk[]> {
  const embedding = await embedText(query, "RETRIEVAL_QUERY");
  return store.search(embedding, TOP_K);
}

export async function retrieve(
  message: string,
  history: HistoryTurn[] = []
): Promise<RetrievalResult> {
  const store = pickStore();
  const original = message.trim();

  /**
   * 主查詢／備援的取捨（2026-09-22）：
   *   - 句子形式上是追問（needsContext）且找得到錨點 → 主查詢＝擴展句、備援＝原句。
   *   - 否則 → 主查詢＝原句、備援＝擴展句（沒有錨點就沒有備援）。
   * 主查詢的 top 低於 HARD_FLOOR 才動用備援，而且備援自己也要 ≥ HARD_FLOOR 才採用；
   * 所以一題最多兩次 embedding，多數題目仍只有一次。
   *
   * 🔴 不可以改成「兩邊都查、取相似度高的」。實測「你怎麼看待做母親這件事」：
   * 原句 0.700（第 9 章〈女兒〉，正確）、接上「書中聶湖濱如何述說李元貞」後 0.743
   * （【他人敘述．聶湖濱】，錯的）——相似度高低分不出哪個才是對的，只有句子本身的
   * 形式分得出來。所以先後順序由 needsContext 決定，相似度只負責「有沒有命中」。
   */
  const anchor = findAnchor(history);
  const expandedQuery = anchor ? withAnchor(original, anchor) : null;
  const [primary, fallback]: [string, string | null] =
    expandedQuery !== null && needsContext(original)
      ? [expandedQuery, original]
      : [original, expandedQuery];

  let query = primary;
  let candidates = await searchOnce(store, primary);
  let top = candidates[0]?.similarity ?? 0;

  if (top < HARD_FLOOR && fallback !== null) {
    const retry = await searchOnce(store, fallback);
    const retryTop = retry[0]?.similarity ?? 0;
    if (retryTop >= HARD_FLOOR) {
      query = fallback;
      candidates = retry;
      top = retryTop;
    }
  }

  const expanded = query !== original;

  if (top < HARD_FLOOR) {
    return {
      chunks: [],
      topSimilarity: top,
      inScope: false,
      lowConfidence: true,
      provider: store.name,
      query,
      expanded,
    };
  }

  const cutoff =
    top >= SOFT_FLOOR ? Math.max(HARD_FLOOR, top - RELATIVE_WINDOW) : HARD_FLOOR;

  return {
    chunks: candidates.filter((c) => c.similarity >= cutoff).slice(0, MAX_CHUNKS),
    topSimilarity: top,
    inScope: true,
    lowConfidence: top < SOFT_FLOOR,
    provider: store.name,
    query,
    expanded,
  };
}
