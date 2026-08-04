import { GoogleGenAI } from "@google/genai";
import { l2Normalize } from "./vector-math";

const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIM = 768;

/** 灌索引時的併發上限。Sunny 原版是裸 Promise.all，語料一大就會撞速率限制。 */
const INGEST_CONCURRENCY = 4;

export type EmbedTaskType = "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";

function createClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenAI({ apiKey });
}

/**
 * taskType 會讓 Gemini 對「問題」與「文件」產生不對稱的向量表示，
 * 檢索品質明顯優於兩邊都用預設。查詢一律 RETRIEVAL_QUERY、語料一律 RETRIEVAL_DOCUMENT。
 */
export async function embedText(
  text: string,
  taskType: EmbedTaskType = "RETRIEVAL_QUERY"
): Promise<number[]> {
  const ai = createClient();
  const response = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
    config: { outputDimensionality: EMBEDDING_DIM, taskType },
  });
  const values = response.embeddings?.[0]?.values;
  if (!values) throw new Error("Gemini embedding returned no vector");
  return l2Normalize(values);
}

/** 有併發上限的批次 embedding，保留輸入順序 */
export async function embedTexts(
  texts: string[],
  taskType: EmbedTaskType = "RETRIEVAL_DOCUMENT",
  onProgress?: (done: number, total: number) => void
): Promise<number[][]> {
  const results: number[][] = new Array(texts.length);
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < texts.length) {
      const i = cursor++;
      results[i] = await embedText(texts[i], taskType);
      done++;
      onProgress?.(done, texts.length);
    }
  }

  const workers = Array.from(
    { length: Math.min(INGEST_CONCURRENCY, texts.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

export { EMBEDDING_DIM, EMBEDDING_MODEL };
