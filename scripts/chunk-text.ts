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
  /** 只用在錯誤訊息（ai:exclude 標記不成對時報「檔名:行號」）；不影響切塊結果 */
  fileName?: string;
}

/**
 * 不進 AI 的段落：`<!-- ai:exclude 理由 -->` 到 `<!-- /ai:exclude -->` 之間的行。
 *
 * 🔴 為什麼要有（2026-09-28）：自傳寫著在世者的近況——老師 2021 年以後的健康與照顧安排、
 * 女兒近年的健康、信仰、經濟與住處。prompt 規則 5 要她不講，但遵守是機率性的；
 * 護欄用正規式攔，換個說法就漏、收窄又誤攔童年往事。穩定的作法是讓這些段落根本不進檢索：
 * 模型看不到，就不可能講出來。書的文字一字不改（標記是 HTML 註解，讀者看不到），
 * 這裡在切塊前把標記之間的行丟掉，標記本身也不進任何塊。
 *
 * 規則（任何一條不符都丟 ExcludeMarkerError，訊息是「檔名:行號: 原因」，build:index 因此失敗）：
 *   - 標記必須各自獨占一行；開始標記一定要寫理由（給之後維護的人看，為什麼這段不進 AI）。
 *   - 不可以巢狀，也不可以不成對。
 *   - 🔴 語料裡不可以有其他 HTML 註解，長得像標記的字（大寫、全形冒號、中間有空白或零寬字元…）也不行。
 *     寫錯的標記不會被認出來，那段就會連同註解文字安靜地進 AI——這是這個機制最危險的失敗方式，
 *     所以寧可讓 build 失敗。（驗收時實測過 `AI:exclude`、`ai：exclude`、`ai: exclude`、`ai-exclude`
 *     成對寫錯時原本不會報錯。）一般的 HTML 註解本來就會被當成內文進塊，語料裡不該有。
 *   - 🔴 標記只認一種寫法：全部半形。判斷「像不像標記」之前，每一行先拿掉零寬字元、再做 NFKC 正規化
 *     （全形英數、全形冒號／驚嘆號／角括號／連字號、全形空白都會變回半形）；正規化後像標記或註解、
 *     原文卻不是標準寫法，就報錯。標記前後的分隔也只認半形空白或 tab，全形空白一樣報錯。
 *     （2026-09-28 獨立審查實測：`＜！－－ ａｉ：ｅｘｃｌｕｄｅ 理由 －－＞`、`＜！－－ ai:exlcude 理由 －－＞`
 *     這類開始與結束都寫成全形的標記，原本兩道檢查都認不出來，排除區的文字就安靜地進了切塊。）
 *   - 標記不可以寫在 front-matter 裡或 front-matter 之前：front-matter 必須是檔案的第一行，
 *     被擠到後面就解析不到，`---`、`source:` 會變成內文。
 *   - 排除區裡不可以有標題行（# ～ ###）：標題決定後面的內文屬於哪一節，
 *     把它丟掉，排除區後面的內文就會掛到上一節的標題底下——等於改了出處。
 *     要排除整節內容，就把標記放在標題之後；只剩標題的小節不會產生任何塊。
 *   - 被丟掉的行換成一個空行，前後段落照樣是兩段，不會被黏成一段。
 */
export class ExcludeMarkerError extends Error {}

export interface ExcludedRange {
  /** 開始標記所在行（1 起算，含 front-matter 的行數，也就是檔案裡的行號） */
  startLine: number;
  /** 結束標記所在行 */
  endLine: number;
  reason: string;
  /** 被排除的內文字數（不含標記、不含空白） */
  chars: number;
}

/**
 * 合格的標記（標準寫法）。分隔只認半形空白與 tab，不用 `\s`：`\s` 連全形空白、不斷行空白都算，
 * 「<!--　ai:exclude　理由　-->」就會被當成合格標記，「只有一種寫法」的規則就破了。
 * （行首行尾的空白另外用 trim() 去掉，不影響判斷。）
 */
const EXCLUDE_OPEN = /^<!--[ \t]*ai:exclude(?:[ \t]+([\s\S]*?))?[ \t]*-->$/;
const EXCLUDE_CLOSE = /^<!--[ \t]*\/ai:exclude[ \t]*-->$/;
const HEADING_LINE = /^#{1,3}\s/;
/** 零寬字元：夾在標記中間時肉眼看不出來 */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
/*
 * 下面三個「像不像標記」的樣式，都拿正規化過的行來比（見 probeText）：
 * 全形的「＜！－－」「－－＞」「ａｉ：ｅｘｃｌｕｄｅ」、全形空白，NFKC 之後都是半形，所以樣式只需要寫半形。
 */
/**
 * 長得像標記的關鍵字：不分大小寫，ai 與 exclude 之間夾 0～3 個空白、標點或符號都算（冒號、連字號、斜線、點…）。
 * ⚠️ 用 new RegExp 字串而不是 regex literal：\p{…} 需要 ES2018，tsconfig 沒設 target，literal 會被 tsc 擋（同 lib/crisis.ts）。
 */
const MARKER_LOOKALIKE = new RegExp("ai[\\s\\p{P}\\p{S}]{0,3}exclude", "iu");
/** 註解的開頭：「<!」，或開頭的核心「!--」（角括號寫成別的字也抓得到） */
const COMMENT_START = /<\s*!|!\s*-\s*-/;
/** 註解的結尾：「-->」 */
const COMMENT_END = /-\s*-\s*>/;

/** 拿掉零寬字元，再做 NFKC 正規化（全形英數、全形標點、全形空白 → 半形）。只用來判斷，不改切塊的內容。 */
function probeText(line: string): string {
  return line.replace(ZERO_WIDTH, "").normalize("NFKC");
}

/** 這一行像不像標記或註解。原文與正規化後各比一次：正規化會把少數符號展開（「…」→「...」），兩邊都比才不會漏。 */
function looksLikeMarker(line: string): boolean {
  const candidates = [line.replace(ZERO_WIDTH, ""), probeText(line)];
  return candidates.some(
    (s) => COMMENT_START.test(s) || COMMENT_END.test(s) || MARKER_LOOKALIKE.test(s)
  );
}

/** 報錯訊息的補充：這一行是因為全形字或零寬字元才認不出來時，把正規化後的樣子印出來，一眼就看得出錯在哪 */
function lookalikeHint(line: string): string {
  const hints: string[] = [];
  const bare = line.replace(ZERO_WIDTH, "");
  if (bare !== line) hints.push("這一行有零寬字元");
  const probe = probeText(line);
  if (probe !== bare) {
    const first = [COMMENT_START, COMMENT_END, MARKER_LOOKALIKE]
      .map((re) => probe.search(re))
      .filter((i) => i >= 0)
      .reduce((a, b) => Math.min(a, b), probe.length);
    const at = Math.max(0, first - 10);
    const excerpt = `${at > 0 ? "…" : ""}${probe.slice(at, at + 60)}${at + 60 < probe.length ? "…" : ""}`;
    hints.push(`這一行有全形或相容字元，正規化後是「${excerpt}」`);
  }
  return hints.length ? `（${hints.join("；")}）` : "";
}

export function stripExcluded(
  raw: string,
  fileName = "（未命名語料）"
): { text: string; excluded: ExcludedRange[] } {
  const out: string[] = [];
  const excluded: ExcludedRange[] = [];
  let open: { line: number; reason: string; chars: number } | null = null;

  const lines = raw.split("\n");
  // front-matter（若有）佔的最後一行；標記不可以落在這一行以前（理由見上方規則）
  const frontMatter = raw.match(/^---\n[\s\S]*?\n---(?:\n|$)/);
  const frontMatterEnd = frontMatter ? frontMatter[0].replace(/\n$/, "").split("\n").length : 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    const trimmed = line.trim();
    const opening = EXCLUDE_OPEN.exec(trimmed);
    const closing = EXCLUDE_CLOSE.test(trimmed);
    const isMarker = Boolean(opening) || closing;

    // 打錯字的標記最危險：它不會被認出來，整段就安靜地進了 AI。
    // 所以除了合格的標記，任何註解、任何長得像標記的字都報錯；先正規化再比，全形寫法也逃不掉。
    if (!isMarker && looksLikeMarker(line)) {
      throw new ExcludeMarkerError(
        `${fileName}:${n}: 看起來是 ai:exclude 標記或 HTML 註解，但不是合格的標記——標記要獨占一行，寫成「<!-- ai:exclude 理由 -->」或「<!-- /ai:exclude -->」（全小寫、全部半形：角括號、驚嘆號、連字號、冒號、空白都是）；語料裡不可以有其他註解${lookalikeHint(line)}`
      );
    }
    if (isMarker && n <= frontMatterEnd) {
      throw new ExcludeMarkerError(`${fileName}:${n}: ai:exclude 標記不可以寫在 front-matter 裡`);
    }
    if (opening) {
      if (open) {
        throw new ExcludeMarkerError(
          `${fileName}:${n}: ai:exclude 不可以巢狀（第 ${open.line} 行的排除區還沒結束）`
        );
      }
      const reason = (opening[1] ?? "").trim();
      if (!reason) {
        throw new ExcludeMarkerError(`${fileName}:${n}: ai:exclude 開始標記要寫理由`);
      }
      open = { line: n, reason, chars: 0 };
      out.push("");
      continue;
    }
    if (closing) {
      if (!open) {
        throw new ExcludeMarkerError(
          `${fileName}:${n}: 多出一個 <!-- /ai:exclude -->，前面沒有對應的開始標記`
        );
      }
      excluded.push({ startLine: open.line, endLine: n, reason: open.reason, chars: open.chars });
      open = null;
      out.push("");
      continue;
    }
    if (open) {
      if (HEADING_LINE.test(line)) {
        throw new ExcludeMarkerError(
          `${fileName}:${n}: 排除區裡不可以有標題行（第 ${open.line} 行開始的排除區）——把標記放在標題之後`
        );
      }
      open.chars += Array.from(line.replace(/\s/g, "")).length;
      continue;
    }
    out.push(line);
  }
  if (open) {
    throw new ExcludeMarkerError(
      `${fileName}:${open.line}: ai:exclude 沒有對應的結束標記 <!-- /ai:exclude -->`
    );
  }
  const text = out.join("\n");
  // 標記寫在 front-matter 之前（或把 front-matter 包起來）：剝完之後 front-matter 不在第一行，會解析不到
  if (!frontMatter && excluded.length > 0 && /^\s*---\n[\s\S]*?\n---(?:\n|$)/.test(text)) {
    throw new ExcludeMarkerError(
      `${fileName}:${excluded[0].startLine}: ai:exclude 標記不可以寫在 front-matter 之前（front-matter 必須是檔案第一行）`
    );
  }
  return { text, excluded };
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
 * 把超過上限的單一段落在句子邊界切開。
 *
 * ⚠️ 沒有這一步的話，`chunkMarkdown` 遇到一個 2000 字的段落只能整段當一塊——
 * 它是「打包段落」不是「切開段落」。實測《我來了！臺灣婦女改變了》的散文段落
 * 長度是 600~2000 字（書的排版本來就是長段落），553 塊裡有 186 塊超過 600 字、
 * 69 塊超過 1000 字。一個向量塞 2000 字，主題會被稀釋到檢索不出來。
 *
 * ⚠️ 帶換行的段落**不切**——那是詩。詩被切成半首比塊太大更糟：
 * 她會把半首詩當散文唸出來。轉檔時詩保留斷行，散文接成一行，
 * 所以「有沒有換行」剛好就是可靠的判準。
 */
export function splitLongParagraph(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  if (paragraph.includes("\n")) return [paragraph]; // 詩，不切

  // 句號／問號／驚嘆號（含後面的收尾引號）當切點
  const sentences = paragraph.match(/[^。！？]*[。！？]+[」』）\)]*|[^。！？]+$/g);
  if (!sentences) return [paragraph];

  const out: string[] = [];
  let pack = "";
  for (const sentence of sentences) {
    if (pack && (pack + sentence).length > maxChars) {
      out.push(pack);
      pack = "";
    }
    // 單一句子就超過上限（極少見，多半是沒有句號的長串）→ 硬切
    if (sentence.length > maxChars) {
      if (pack) { out.push(pack); pack = ""; }
      for (let i = 0; i < sentence.length; i += maxChars) {
        out.push(sentence.slice(i, i + maxChars));
      }
      continue;
    }
    pack += sentence;
  }
  if (pack) out.push(pack);
  return out;
}

/**
 * 依 markdown 的 ## 標題分節，節內再依段落打包成塊（含重疊）。
 */
export function chunkMarkdown(
  raw: string,
  fallback: SourceMeta,
  options: ChunkOptions = {}
): Chunk[] {
  const { maxChars = 400, overlapParagraphs = 1, fileName } = options;
  // 先剝掉 ai:exclude 排除區（理由見 stripExcluded），再解析 front-matter 與切節
  const { meta, body } = parseFrontMatter(stripExcluded(raw, fileName).text);

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
      .filter(Boolean)
      // 超長的散文段落先在句子邊界切開，見 splitLongParagraph 的說明
      .flatMap((p) => splitLongParagraph(p, maxChars));

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
