/**
 * 切塊策略（相對 Sunny 原版的三項改良）：
 *  1. maxChars 400（中文比英文密，500 偏粗）
 *  2. 段落重疊 — Sunny 完全沒有，這是檢索品質最大的單一改善
 *  3. 標題麵包屑 — 純中文塊沒有主題錨點會 embed 得很差，
 *     所以送去 embedding 的文字前面掛上【檔案標題 · 小節標題】
 */

export interface SourceMeta {
  source: string;
  sourceUrl: string;
  docTitle: string;
}

export interface Chunk {
  /** 顯示給人看的原文 */
  content: string;
  /** 真正送去 embedding 的文字（＝麵包屑 + content） */
  embedInput: string;
  /** 麵包屑，也拿來當引用標題 */
  title: string;
  source: string;
  sourceUrl: string;
}

export interface ChunkOptions {
  maxChars?: number;
  /** 重疊幾個段落 */
  overlapParagraphs?: number;
}

/** 解析檔頭的 front-matter（source / sourceUrl / title），回傳 meta 與剩餘內文 */
export function parseFrontMatter(raw: string): {
  meta: Partial<SourceMeta>;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { meta: {}, body: raw };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }

  return {
    meta: {
      source: meta.source,
      sourceUrl: meta.sourceUrl,
      docTitle: meta.title,
    },
    body: raw.slice(match[0].length),
  };
}

/**
 * 依 markdown 的 ## 標題分節，節內再依段落打包成塊（含重疊）。
 */
export function chunkMarkdown(
  raw: string,
  fallback: SourceMeta,
  options: ChunkOptions = {}
): Chunk[] {
  const { maxChars = 400, overlapParagraphs = 1 } = options;
  const { meta, body } = parseFrontMatter(raw);

  const source = meta.source ?? fallback.source;
  const sourceUrl = meta.sourceUrl ?? fallback.sourceUrl;
  const docTitle = meta.docTitle ?? fallback.docTitle;

  // 依 ## 標題切節，保留標題文字
  const sections: { heading: string; text: string }[] = [];
  let currentHeading = "";
  let buffer: string[] = [];

  for (const line of body.split("\n")) {
    const h = line.match(/^#{1,3}\s+(.*)$/);
    if (h) {
      if (buffer.join("\n").trim()) {
        sections.push({ heading: currentHeading, text: buffer.join("\n") });
      }
      currentHeading = h[1].trim();
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  if (buffer.join("\n").trim()) {
    sections.push({ heading: currentHeading, text: buffer.join("\n") });
  }

  const chunks: Chunk[] = [];

  for (const section of sections) {
    const breadcrumb = section.heading
      ? `【${docTitle} · ${section.heading}】`
      : `【${docTitle}】`;

    const paragraphs = section.text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);

    let pack: string[] = [];

    const flush = () => {
      if (!pack.length) return;
      const content = pack.join("\n\n");
      chunks.push({
        content,
        embedInput: `${breadcrumb}\n${content}`,
        title: section.heading ? `${docTitle} · ${section.heading}` : docTitle,
        source,
        sourceUrl,
      });
    };

    for (const paragraph of paragraphs) {
      const candidate = [...pack, paragraph].join("\n\n");
      if (candidate.length > maxChars && pack.length) {
        flush();
        // 重疊：把上一塊尾端幾段接到下一塊開頭，避免答案被切在邊界上
        pack = overlapParagraphs > 0 ? pack.slice(-overlapParagraphs) : [];
        pack.push(paragraph);
      } else {
        pack.push(paragraph);
      }
    }
    flush();
  }

  return chunks;
}
