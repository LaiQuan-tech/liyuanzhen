import { createAdminSupabase } from "../supabase";
import type { KnowledgeChunk, VectorStore } from "./types";

/** RPC 回傳的是 SQL 欄位名（snake_case），型別是 camelCase */
interface MatchRow {
  id: string;
  source: string;
  source_url: string | null;
  title: string | null;
  content: string;
  similarity: number;
}

/**
 * Stage 2 用。RPC 的 similarity 是 `1 - (embedding <=> query)`，即餘弦，
 * 與 local.ts 的 cosineSimilarity 語義一致——門檻才能兩邊通用。
 */
export const supabaseStore: VectorStore = {
  name: "supabase",
  async search(embedding: number[], k: number): Promise<KnowledgeChunk[]> {
    const supabase = createAdminSupabase();
    const { data, error } = await supabase.rpc("match_knowledge_chunks", {
      query_embedding: embedding,
      match_count: k,
    });
    if (error) throw new Error(`Supabase 檢索失敗：${error.message}`);

    // ⚠️ 一定要顯式對映，不能直接 cast。
    // RPC 給的是 source_url，型別要的是 sourceUrl；直接 cast 會讓 sourceUrl
    // 在執行期靜默變成 undefined，而 TypeScript 完全不會抱怨。
    // 目前線上正是走這個 provider，所以這不是假設性的問題。
    return ((data ?? []) as MatchRow[]).map((row) => ({
      id: row.id,
      source: row.source,
      sourceUrl: row.source_url ?? "",
      title: row.title ?? "",
      content: row.content,
      similarity: row.similarity,
    }));
  },
};
