import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import index from "@/data/knowledge-index.json";

/**
 * 語料雜湊守門。
 *
 * ⚠️ 這條測試防的是一種**靜默失敗**：有人改了 content/knowledge/*.md，
 * 但忘了跑 `npm run build:index`。頁面上顯示的是新版文案，
 * 而聊天機器人被問到同一題時還在背舊索引裡的舊答案——
 * 網站當著使用者的面否定自己，而且沒有任何錯誤訊息。
 *
 * 這件事在「提案展示版轉正式站」時真的差點發生：頁面已經改成
 * 「臉和聲音是她的」，但索引裡還躺著「因為尚未取得肖像授權」。
 *
 * 演算法必須跟 scripts/build-index.ts 完全一致：
 *   讀 content/knowledge/*.md → 檔名排序 → 依序 sha256 update 原始位元組
 *   → hex 前 16 碼
 * 改了那支就要改這裡，否則這條測試會變成永遠紅燈的雜訊。
 */
const KNOWLEDGE_DIR = join(process.cwd(), "content", "knowledge");

function computeSourceHash(): string {
  const files = readdirSync(KNOWLEDGE_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(readFileSync(join(KNOWLEDGE_DIR, file), "utf-8"));
  }
  return hash.digest("hex").slice(0, 16);
}

describe("語料與索引必須同步", () => {
  it("⚠️ 語料的 sha256 要等於索引裡的 sourceHash", () => {
    const actual = computeSourceHash();
    expect(
      actual,
      `語料改過但索引沒重建。跑這兩支（互不觸發，缺一等於沒改）：\n` +
        `  npm run build:index      → data/knowledge-index.json\n` +
        `  npm run ingest:supabase  → Supabase knowledge_chunks 表\n` +
        `語料現在是 ${actual}，索引裡記的是 ${index.sourceHash}`
    ).toBe(index.sourceHash);
  });

  it("索引不是空的，而且每一塊都有向量", () => {
    expect(index.entries.length).toBeGreaterThan(0);
    for (const entry of index.entries) {
      expect(entry.embedding.length, entry.id).toBe(index.dim);
    }
  });

  it("每一篇語料的來源都出現在索引裡", () => {
    // ⚠️ 索引裡的 source 是 frontmatter 的 `source:` 值（例如「本網站說明」），
    // **不是檔名**，而且不是一對一——07 與 08 兩篇共用「本網站說明」。
    // 所以要比對的是「frontmatter 宣告的來源集合」對「索引裡的來源集合」。
    const declared: Set<string> = new Set(
      readdirSync(KNOWLEDGE_DIR)
        .filter((f) => f.endsWith(".md"))
        .map((f) => readFileSync(join(KNOWLEDGE_DIR, f), "utf-8").match(/^source:\s*(.+)$/m)?.[1].trim())
        .filter(Boolean) as string[]
    );
    const indexed = new Set(index.entries.map((e) => e.source));
    // ⚠️ 不要寫成 for...of Set——展開／迭代 Set 需要 downlevelIteration，
    // tsconfig 沒開，會是 TS2802（而且只在 tsc 才報，vitest 照跑）
    for (const source of Array.from(declared)) {
      expect(indexed.has(source), `語料宣告了來源「${source}」，索引裡卻找不到`).toBe(true);
    }
  });
});
