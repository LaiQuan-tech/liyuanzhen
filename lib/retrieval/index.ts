import { embedText } from "../embeddings";
import { expandQuery, type HistoryTurn } from "../query-expansion";
import { hasSupabase } from "../supabase";
import { localStore } from "./local";
import { supabaseStore } from "./supabase";
import type { RetrievalResult, VectorStore } from "./types";

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

export async function retrieve(
  message: string,
  history: HistoryTurn[] = []
): Promise<RetrievalResult> {
  const store = pickStore();
  const query = expandQuery(message, history);
  const embedding = await embedText(query, "RETRIEVAL_QUERY");
  const candidates = await store.search(embedding, TOP_K);

  const top = candidates[0]?.similarity ?? 0;

  if (top < HARD_FLOOR) {
    return {
      chunks: [],
      topSimilarity: top,
      inScope: false,
      lowConfidence: true,
      provider: store.name,
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
  };
}
