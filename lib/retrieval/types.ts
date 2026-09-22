export interface KnowledgeChunk {
  id: string;
  source: string;
  sourceUrl: string;
  title: string;
  content: string;
  similarity: number;
}

export interface RetrievalResult {
  chunks: KnowledgeChunk[];
  topSimilarity: number;
  /** false 代表問題離語料太遠，路由應直接婉拒、不呼叫 LLM */
  inScope: boolean;
  /** 命中但不夠強，prompt 會追加「不確定就說不知道」 */
  lowConfidence: boolean;
  /** 實際使用的檢索來源，方便除錯與驗收 */
  provider: "local" | "supabase";
  /**
   * 實際拿去 embedding 的查詢字串（原句，或接了上一題錨點的擴展句），供除錯與對話重放驗收。
   * ⚠️ 必須是可選：app/api/chat/route.ts 檢索失敗時有一個手寫的 fallback 物件沒有這兩欄。
   */
  query?: string;
  /** true 代表最後採用的是擴展句（接了上一題當錨點）；同上，可選 */
  expanded?: boolean;
}

export interface VectorStore {
  readonly name: "local" | "supabase";
  search(embedding: number[], k: number): Promise<KnowledgeChunk[]>;
}
