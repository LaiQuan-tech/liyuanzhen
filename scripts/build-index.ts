/**
 * 把 content/knowledge/*.md 轉成兩個產物：
 *
 *   data/knowledge-index.json  含向量的檢索索引（要打 Gemini embedding API）
 *   lib/known-titles.ts        語料裡出現過的所有《》〈〉標題（純文字掃描，不打 API）
 *
 * 用法：
 *   npm run build:index    兩個都重建（會呼叫 Gemini，868 塊約數分鐘、要錢）
 *   npm run build:titles   只重建 lib/known-titles.ts
 *
 * 🔴 標題掃描刻意做成可以單獨執行的子命令。
 * 它跟 embedding 完全無關——只是把語料檔案用正規式掃過一遍——但如果綁在
 * 全量重建裡，每次想更新標題白名單就得重算 868 塊向量：又慢、又花錢，
 * 而且會讓 data/knowledge-index.json 的 builtAt 無謂地跳動（那個欄位是
 * 「索引跟語料同不同步」的唯一線索，不該因為改白名單就失真）。
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
const TITLES_PATH = join(process.cwd(), "lib", "known-titles.ts");

/** 兩個子命令共用，保證掃標題與切塊看到的是同一批檔案、同一個順序 */
function knowledgeFiles(): string[] {
  const files = readdirSync(KNOWLEDGE_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (files.length === 0) {
    console.error(`找不到任何語料：${KNOWLEDGE_DIR}`);
    process.exit(1);
  }
  return files;
}

/**
 * 掃出語料裡所有《…》〈…〉標題，去重、去頭尾空白、照字典序排。
 *
 * ⚠️ 這支正規式必須跟 lib/answer-guard.ts 的 citations() 一致。
 * 那邊抓答案裡的引用、這邊抓語料裡的引用，兩邊形狀不一樣的話，
 * 白名單就會漏掉本來該放行的標題——而症狀是「她講了一個語料裡明明有的書名卻被攔」，
 * 從現象很難回推到這裡。
 */
export function collectTitles(): string[] {
  const seen = new Set<string>();
  for (const file of knowledgeFiles()) {
    const raw = readFileSync(join(KNOWLEDGE_DIR, file), "utf-8");
    const re = /《([^》\n]{0,60})》|〈([^〉\n]{0,60})〉/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const title = (m[1] ?? m[2] ?? "").trim();
      if (title) seen.add(title);
    }
  }
  return Array.from(seen).sort();
}

/**
 * 產生 lib/known-titles.ts。純檔案操作，不呼叫任何 API。
 *
 * ⚠️ 用 .ts 不用 .json：tsconfig 雖然開著 resolveJsonModule，但 vitest、tsx 與
 * next build 三邊對 JSON import 的處理方式不一致，而這個檔案要被 lib/ 底下的
 * 執行期程式碼 import。.ts 沒有這個問題，代價只是多一行 export。
 */
export function writeKnownTitles(): string[] {
  const titles = collectTitles();
  const body = titles.map((t) => `  ${JSON.stringify(t)},`).join("\n");
  const source = `// 由 scripts/build-index.ts 產生，不要手改。語料裡出現過的所有《》〈〉標題。
// 重新產生：npm run build:titles
//
// 用途見 lib/answer-guard.ts 的引用落地檢查：答案裡的《…》〈…〉只要在這份清單裡，
// 就算這次沒檢索到，也不算編造——她引用自己創辦的雜誌與講過幾十次的法條是常態。
export const KNOWN_TITLES: readonly string[] = [
${body}
];
`;
  writeFileSync(TITLES_PATH, source);
  return titles;
}

async function buildIndex() {
  const files = knowledgeFiles();
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

function buildTitles() {
  const titles = writeKnownTitles();
  console.log(`✅ 已寫入 ${TITLES_PATH}（${titles.length} 個標題，未呼叫任何 API）`);
}

async function main() {
  // 只有 `titles` 子命令時跳過 embedding。預設仍是全量重建，行為不變。
  if (process.argv[2] === "titles") {
    buildTitles();
    return;
  }
  await buildIndex();
  buildTitles();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
