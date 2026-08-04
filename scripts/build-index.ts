/**
 * 把 content/knowledge/*.md 轉成 data/knowledge-index.json（含向量），供本機檢索使用。
 *
 * 用法：npm run build:index
 *
 * ⚠️ 刻意「不」掛進 prebuild——那會讓每次 Vercel 部署都打 Gemini API，
 * 又慢又不穩又花錢。請在本機產生後 commit 產物。
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { chunkMarkdown } from "./chunk-text";
import { embedTexts, EMBEDDING_MODEL, EMBEDDING_DIM } from "../lib/embeddings";

const KNOWLEDGE_DIR = join(process.cwd(), "content", "knowledge");
const OUTPUT_PATH = join(process.cwd(), "data", "knowledge-index.json");

async function main() {
  const files = readdirSync(KNOWLEDGE_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();

  if (files.length === 0) {
    console.error(`找不到任何語料：${KNOWLEDGE_DIR}`);
    process.exit(1);
  }

  const allChunks = [];
  const hash = createHash("sha256");

  for (const file of files) {
    const raw = readFileSync(join(KNOWLEDGE_DIR, file), "utf-8");
    hash.update(raw);
    const chunks = chunkMarkdown(raw, {
      source: basename(file, ".md"),
      sourceUrl: "",
      docTitle: basename(file, ".md"),
    });
    console.log(`  ${file} → ${chunks.length} 塊`);
    allChunks.push(...chunks);
  }

  console.log(`\n總共 ${allChunks.length} 塊，開始 embedding…`);

  const vectors = await embedTexts(
    allChunks.map((c) => c.embedInput),
    "RETRIEVAL_DOCUMENT",
    (done, total) => {
      if (done % 10 === 0 || done === total) {
        process.stdout.write(`\r  embedding ${done}/${total}`);
      }
    }
  );
  process.stdout.write("\n");

  const index = {
    model: EMBEDDING_MODEL,
    dim: EMBEDDING_DIM,
    builtAt: new Date().toISOString(),
    sourceHash: hash.digest("hex").slice(0, 16),
    entries: allChunks.map((chunk, i) => ({
      id: `${chunk.source}#${i}`,
      source: chunk.source,
      sourceUrl: chunk.sourceUrl,
      title: chunk.title,
      content: chunk.content,
      // 5 位小數足夠：對餘弦的影響遠小於門檻的解析度，檔案卻小很多
      embedding: vectors[i].map((v) => Number(v.toFixed(5))),
    })),
  };

  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(index));

  const sizeKb = Math.round(JSON.stringify(index).length / 1024);
  console.log(`\n✅ 已寫入 ${OUTPUT_PATH}（${index.entries.length} 塊，約 ${sizeKb} KB）`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
