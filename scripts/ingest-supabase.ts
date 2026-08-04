/**
 * 把 content/knowledge/*.md 灌進 Supabase 的 knowledge_chunks。
 * 用法：npm run ingest:supabase
 *
 * 與 Sunny 原版的關鍵差異：先依 source 刪除再插入。
 * 原版是純 append，重跑一次語料就整份重複，檢索會被同樣的內容洗版。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { chunkMarkdown } from "./chunk-text";
import { embedTexts } from "../lib/embeddings";
import { createAdminSupabase } from "../lib/supabase";

const KNOWLEDGE_DIR = join(process.cwd(), "content", "knowledge");

async function main() {
  const supabase = createAdminSupabase();
  const files = readdirSync(KNOWLEDGE_DIR).filter((f) => f.endsWith(".md")).sort();

  for (const file of files) {
    const source = basename(file, ".md");
    const raw = readFileSync(join(KNOWLEDGE_DIR, file), "utf-8");
    const chunks = chunkMarkdown(raw, { source, sourceUrl: "", docTitle: source });

    // 先刪後插，確保重跑是冪等的
    const { error: delError } = await supabase
      .from("knowledge_chunks")
      .delete()
      .eq("source", source);
    if (delError) throw new Error(`刪除舊資料失敗（${source}）：${delError.message}`);

    const vectors = await embedTexts(
      chunks.map((c) => c.embedInput),
      "RETRIEVAL_DOCUMENT"
    );

    const rows = chunks.map((chunk, i) => ({
      source: chunk.source,
      source_url: chunk.sourceUrl,
      title: chunk.title,
      content: chunk.content,
      embedding: vectors[i],
    }));

    const { error } = await supabase.from("knowledge_chunks").insert(rows);
    if (error) throw new Error(`寫入失敗（${source}）：${error.message}`);

    console.log(`  ✅ ${source}：${rows.length} 塊`);
  }

  const { count } = await supabase
    .from("knowledge_chunks")
    .select("*", { count: "exact", head: true });
  console.log(`\n完成，knowledge_chunks 目前共 ${count} 列`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
