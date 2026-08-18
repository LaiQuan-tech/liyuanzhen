/**
 * 把 content/knowledge/*.md 灌進 Supabase 的 knowledge_chunks。
 * 用法：npm run ingest:supabase
 *
 * ⚠️ 這支曾經有一個會靜默累積的 bug，修法記在這裡免得有人改回去：
 *
 * 舊版是逐檔「先依 source 刪除再插入」，宣稱這樣就冪等。但它
 * **刪除用的 key 跟寫入的值不是同一個東西**——
 *   刪：`.eq("source", basename(file, ".md"))`   → "07-about-this-site"
 *   寫：`source: chunk.source`                    → "本網站說明"（來自 frontmatter）
 * 於是刪除永遠一筆都沒命中，每跑一次就整份疊上去。
 * 實際發現時資料表有 111 列，而語料只有 56 塊——**舊版本的內容全都還在，
 * 包括已經改掉的「尚未取得肖像授權」**。檢索會同時撈到新舊兩種說法。
 *
 * 而且光是「改成用 chunk.source 當刪除 key」也不夠：
 * 07 與 08 兩篇的 frontmatter 都寫 `本網站說明`，逐檔刪插會讓後一篇
 * 把前一篇剛寫進去的資料刪掉。來源與檔案根本不是一對一。
 *
 * 所以改成：**全部算完 → 清空整張表 → 一次寫入**。
 * 語料只有幾十塊，這是最單純也唯一真正冪等的作法。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { chunkMarkdown } from "./chunk-text";
import { embedTexts } from "../lib/embeddings";
import { createAdminSupabase } from "../lib/supabase";

const KNOWLEDGE_DIR = join(process.cwd(), "content", "knowledge");

async function main() {
  const supabase = createAdminSupabase();
  const files = readdirSync(KNOWLEDGE_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();

  // ── 1. 先把所有東西算完，再動資料庫 ──────────────────────
  // 這個順序很重要：embedding 會呼叫外部 API，可能失敗或很慢。
  // 先清表再算，一旦中途失敗就會留下一張空表，站上檢索直接全滅。
  const rows: {
    source: string;
    source_url: string;
    title: string;
    content: string;
    embedding: number[];
  }[] = [];

  for (const file of files) {
    const fallbackSource = basename(file, ".md");
    const raw = readFileSync(join(KNOWLEDGE_DIR, file), "utf-8");
    const chunks = chunkMarkdown(raw, {
      source: fallbackSource,
      sourceUrl: "",
      docTitle: fallbackSource,
    });

    const vectors = await embedTexts(
      chunks.map((c) => c.embedInput),
      "RETRIEVAL_DOCUMENT"
    );

    chunks.forEach((chunk, i) => {
      rows.push({
        source: chunk.source,
        source_url: chunk.sourceUrl,
        title: chunk.title,
        content: chunk.content,
        embedding: vectors[i],
      });
    });

    console.log(`  ✅ ${file} → ${chunks.length} 塊（source：${chunks[0]?.source ?? "?"}）`);
  }

  if (rows.length === 0) {
    throw new Error("一塊都沒算出來，不動資料庫");
  }

  // ── 2. 清空整張表 ────────────────────────────────────────
  // ⚠️ 不要改回「依 source 逐筆刪」。來源與檔案不是一對一（07 與 08 共用
  // 「本網站說明」），逐檔刪插會互相蓋掉。整張清掉才是對的。
  console.log(`\n清空 knowledge_chunks…`);
  const { error: delError } = await supabase
    .from("knowledge_chunks")
    .delete()
    .not("id", "is", null); // PostgREST 不接受無條件 delete，這是「全部」的寫法
  if (delError) throw new Error(`清空失敗：${delError.message}`);

  // ── 3. 一次寫入 ──────────────────────────────────────────
  console.log(`寫入 ${rows.length} 塊…`);
  const { error } = await supabase.from("knowledge_chunks").insert(rows);
  if (error) throw new Error(`寫入失敗：${error.message}`);

  const { count } = await supabase
    .from("knowledge_chunks")
    .select("*", { count: "exact", head: true });

  console.log(`\n完成，knowledge_chunks 共 ${count} 列`);
  if (count !== rows.length) {
    throw new Error(`列數對不上：算出 ${rows.length} 塊，表裡卻有 ${count} 列`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
