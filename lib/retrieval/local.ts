import { cosineSimilarity } from "../vector-math";
import type { KnowledgeChunk, VectorStore } from "./types";

interface IndexEntry {
  id: string;
  source: string;
  sourceUrl: string;
  title: string;
  content: string;
  embedding: number[];
}

interface IndexFile {
  model: string;
  dim: number;
  builtAt: string;
  entries: IndexEntry[];
}

let cache: IndexFile | null = null;

async function loadIndex(): Promise<IndexFile> {
  if (cache) return cache;
  // 動態 import 讓 JSON 只在真正需要時才進記憶體，且能被打包進 serverless bundle
  const mod = await import("@/data/knowledge-index.json");
  cache = (mod.default ?? mod) as unknown as IndexFile;
  return cache;
}

/**
 * 語料規模在數十到數百塊時，行程內餘弦比 pgvector 來回還快。
 * 之所以仍要 Stage 2 的 Supabase，是為了寫入（提問牆／報名）與可編輯性，不是檢索效能。
 */
export const localStore: VectorStore = {
  name: "local",
  async search(embedding: number[], k: number): Promise<KnowledgeChunk[]> {
    const index = await loadIndex();
    const scored = index.entries.map((entry) => ({
      id: entry.id,
      source: entry.source,
      sourceUrl: entry.sourceUrl,
      title: entry.title,
      content: entry.content,
      similarity: cosineSimilarity(embedding, entry.embedding),
    }));
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, k);
  },
};
