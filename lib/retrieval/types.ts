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
}

export interface VectorStore {
  readonly name: "local" | "supabase";
  search(embedding: number[], k: number): Promise<KnowledgeChunk[]>;
}
