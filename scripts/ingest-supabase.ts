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
 * 所以改成：**全部切完 → 全部 embedding → 清空整張表 → 一次寫入**。
 * 語料只有幾十塊，這是最單純也唯一真正冪等的作法。
 *
 * 🔴 「全部切完」跟「全部 embedding」也分成兩輪（2026-09-28）：舊版在同一個迴圈裡逐檔「切一檔、打一檔
 * embedding」，後面的檔 ai:exclude 標記寫錯時，前面的檔已經花錢打過 embedding 才失敗。
 * 現在所有檔都切完、標記檢查全部通過，才打第一個 embedding（同 scripts/build-index.ts）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { chunkMarkdown, stripExcluded, type Chunk } from "./chunk-text";
import { embedTexts, EMBEDDING_DIM } from "../lib/embeddings";
import { createAdminSupabase } from "../lib/supabase";

const KNOWLEDGE_DIR = join(process.cwd(), "content", "knowledge");

async function main() {
  const supabase = createAdminSupabase();
  const files = readdirSync(KNOWLEDGE_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();

  // ── 1. 先把所有檔切塊（含 ai:exclude 標記檢查），還不打 API、不動資料庫 ──
  // 標記寫錯會在這裡丟 ExcludeMarkerError（檔名:行號）：一個 embedding 都還沒打，資料庫也沒動。
  const allChunks: Chunk[] = [];
  for (const file of files) {
    const fallbackSource = basename(file, ".md");
    const raw = readFileSync(join(KNOWLEDGE_DIR, file), "utf-8");
    const chunks = chunkMarkdown(
      raw,
      { source: fallbackSource, sourceUrl: "", docTitle: fallbackSource },
      { fileName: file }
    );
    const { excluded } = stripExcluded(raw, file);
    const note = excluded.length
      ? `，ai:exclude 排除 ${excluded.length} 段、${excluded.reduce((s, r) => s + r.chars, 0)} 字`
      : "";
    console.log(`  ${file} → ${chunks.length} 塊（source：${chunks[0]?.source ?? "?"}${note}）`);
    allChunks.push(...chunks);
  }

  if (allChunks.length === 0) {
    throw new Error("一塊都沒切出來，不動資料庫");
  }

  // ── 2. 全部切完、標記全部通過，才開始打 embedding ─────────
  // 這個順序也很重要：embedding 會呼叫外部 API，可能失敗或很慢。
  // 先清表再算，一旦中途失敗就會留下一張空表，站上檢索直接全滅。所以清表在 embedding 全部成功之後。
  console.log(`\n總共 ${allChunks.length} 塊，開始 embedding…`);
  const vectors = await embedTexts(
    allChunks.map((c) => c.embedInput),
    "RETRIEVAL_DOCUMENT",
    (done, total) => {
      if (done % 10 === 0 || done === total) process.stdout.write(`\r  embedding ${done}/${total}`);
    }
  );
  process.stdout.write("\n");
  if (vectors.length !== allChunks.length) {
    throw new Error(`embedding 數量對不上：${vectors.length} 個向量、${allChunks.length} 塊，不動資料庫`);
  }
  const broken = vectors.findIndex((v) => !Array.isArray(v) || v.length !== EMBEDDING_DIM);
  if (broken !== -1) {
    throw new Error(`第 ${broken + 1} 塊的向量維度不是 ${EMBEDDING_DIM}，不動資料庫`);
  }

  const rows = allChunks.map((chunk, i) => ({
    source: chunk.source,
    source_url: chunk.sourceUrl,
    title: chunk.title,
    content: chunk.content,
    embedding: vectors[i],
  }));

  // ── 3. 清空整張表 ────────────────────────────────────────
  // ⚠️ 不要改回「依 source 逐筆刪」。來源與檔案不是一對一（07 與 08 共用
  // 「本網站說明」），逐檔刪插會互相蓋掉。整張清掉才是對的。
  console.log(`\n清空 knowledge_chunks…`);
  const { error: delError } = await supabase
    .from("knowledge_chunks")
    .delete()
    .not("id", "is", null); // PostgREST 不接受無條件 delete，這是「全部」的寫法
  if (delError) throw new Error(`清空失敗：${delError.message}`);

  // ── 4. 分批寫入 ──────────────────────────────────────────
  // ⚠️ 一次全送會爆掉：762 塊 × 768 維 float ≈ 7.6MB 的 JSON body，
  // 超過 PostgREST 的請求上限。分批是**寫入方式**的改變，
  // 不是策略的改變——上面「全部算完 → 清空整張表」那個順序不可以動。
  const BATCH = 100;
  console.log(`寫入 ${rows.length} 塊（每批 ${BATCH}）…`);
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await supabase.from("knowledge_chunks").insert(slice);
    if (error) {
      throw new Error(
        `寫入失敗（第 ${i + 1}~${i + slice.length} 塊）：${error.message}\n` +
          "⚠️ 表已經清空但沒寫完，站上的檢索現在是壞的。修好之後一定要重跑這支。"
      );
    }
    process.stdout.write(`  ${Math.min(i + BATCH, rows.length)}/${rows.length}\r`);
  }
  console.log("");

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
