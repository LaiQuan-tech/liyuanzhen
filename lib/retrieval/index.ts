import { embedText } from "../embeddings";
import {
  cleanSpokenQuery,
  findAnchor,
  isFollowUp,
  withAnchor,
  type HistoryTurn,
} from "../query-expansion";
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

/** 主查詢／備援的候選：原本的字串（還沒清口語包裝），以及它是不是接了錨點的擴展句 */
interface QueryCandidate {
  text: string;
  expanded: boolean;
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
   *   - 句子形式上是追問（isFollowUp＝清過口語包裝後的 needsContext）且找得到錨點 → 主查詢＝擴展句、備援＝原句。
   *   - 否則 → 主查詢＝原句、備援＝擴展句（沒有錨點就沒有備援）。
   * 主查詢的 top 低於 HARD_FLOOR 才動用備援，而且備援自己也要 ≥ HARD_FLOOR 才採用；
   * 所以一題最多兩次 embedding，多數題目仍只有一次。
   *
   * 🔴 不可以改成「兩邊都查、取相似度高的」。實測「你怎麼看待做母親這件事」：
   * 原句 0.700（第 9 章〈女兒〉，正確）、接上「書中聶湖濱如何述說李元貞」後 0.743
   * （【他人敘述．聶湖濱】，錯的）——相似度高低分不出哪個才是對的，只有句子本身的
   * 形式分得出來。所以先後順序由句子形式（needsContext）決定，相似度只負責「有沒有命中」。
   *
   * 口語清理（2026-09-28）：拿去 embedding 的字串先過 cleanSpokenQuery，去掉「剛剛講太快了」「老師妳好」
   * 「請問一下」「嗯」這類不帶內容的包裝（V-07 原句撈不到出生段、清完排第 2，數字見 lib/query-expansion.ts）。
   * 追問判斷也看清過的句子（isFollowUp，findAnchor 跳過追問也是）：用原句判斷時「嗯 妳確定？」
   * 「老師，請問一下，那後來呢？」都認不出是追問，只拿「妳確定？」去檢索，撈到的正是〈它會答錯嗎〉。
   * 這些都只影響檢索；送進模型的問題仍是原句（route.ts 的 question 沒經過這裡）。
   */
  const anchor = findAnchor(history);
  const plain: QueryCandidate = { text: original, expanded: false };
  const withContext: QueryCandidate | null = anchor
    ? { text: withAnchor(original, anchor), expanded: true }
    : null;
  const [primary, fallback]: [QueryCandidate, QueryCandidate | null] =
    withContext !== null && isFollowUp(original) ? [withContext, plain] : [plain, withContext];

  let adopted = primary;
  let query = cleanSpokenQuery(primary.text);
  let candidates = await searchOnce(store, query);
  let top = candidates[0]?.similarity ?? 0;

  if (top < HARD_FLOOR && fallback !== null) {
    const retryQuery = cleanSpokenQuery(fallback.text);
    // 錨點整句都是包裝（例如「老師妳好」）時，備援清完會跟主查詢一字不差；再查一次只會得到同一個結果
    if (retryQuery !== query) {
      const retry = await searchOnce(store, retryQuery);
      const retryTop = retry[0]?.similarity ?? 0;
      if (retryTop >= HARD_FLOOR) {
        adopted = fallback;
        query = retryQuery;
        candidates = retry;
        top = retryTop;
      }
    }
  }

  // ⚠️ 不能再用 query !== original 推：清過口語包裝的原句也會跟原句不同
  const expanded = adopted.expanded;

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
