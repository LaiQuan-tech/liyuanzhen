/**
 * 必須是真餘弦相似度（除以兩個 norm），不能用裸內積。
 * Supabase 端的 `1 - (embedding <=> q)` 就是餘弦；若本機端用內積，
 * 兩個 provider 的 similarity 語義會不同，門檻會在切換到 Stage 2 時悄悄失準。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`向量維度不符：${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** 寫入索引時先正規化，當作 cosineSimilarity 的雙保險 */
export function l2Normalize(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v.slice();
  return v.map((x) => x / norm);
}
