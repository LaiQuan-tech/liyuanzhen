/**
 * 把《我來了！臺灣婦女改變了》的 PDF 轉成 content/knowledge/ 底下的 markdown。
 *
 * 用法：
 *   npx tsx scripts/import-autobiography.ts "/path/to/自傳全文.pdf"
 *
 * 這是**一次性的匯入工具**，不是每次 build 都會跑的東西。轉完之後產出的 .md
 * 就是語料本體，之後要修內容直接改 .md，不要回頭改這支再重跑
 * （重跑會蓋掉人工修過的地方）。
 *
 * ⚠️ 需要 poppler 的 `pdftotext`（macOS：brew install poppler）。
 * 沒有它就直接失敗，不要靜默產出空檔——空語料會讓整站的檢索全滅。
 *
 * ── 這本書的排版事實（2026-08-20 實測 266 頁）────────────────────
 *
 * - 章標題在內文裡是 `1. 眷村歲月——鐵絲網圈住的童年`，**第 10 章是兩位數**
 * - 目錄頁同樣是 `1. 眷村歲月………6` 這種行，用「含連續的 …」排除
 * - 頁碼是獨立一行的純數字，夾在內文中間，一定要拿掉
 * - 中文段落內是硬換行（PDF 的視覺換行），**空行才是真的段落分界**
 * - 小節標題在 PDF 裡是底線字，pdftotext 抽出來只剩「前後空行的短行」
 * - 詩**散落在各章**，不是只有第 6 章。詩的行不可以接起來
 *
 * ── 🔴 他人第一人稱專文 ─────────────────────────────────────────
 *
 * 書裡不是每一段都是李元貞在說話。格式是：
 *
 *     堪稱「臺灣婦運之母」的李元貞
 *     ◎ 葉菊蘭
 *     1989 年我選上立委，那是我與李元貞實質合作的開始。
 *
 * 這種段落若被檢索到而沒有標記，數位李元貞會用她的臉和克隆聲音說
 * 「我選上立委」「我擔任行政院副院長」——在基金會的官方網站上，
 * 用她本人的肖像講一句她沒做過的事。
 *
 * 🔴 **標記符號有三種，長得幾乎一樣但碼位不同**，全書共 12 篇：
 *     ⊙ U+2299 CIRCLED DOT OPERATOR ……… 7 篇
 *     ☉ U+2609 SUN ……………………………… 3 篇
 *     ◎ U+25CE BULLSEYE ………………………… 2 篇
 * 第一版只比對 ◎，結果 12 篇裡只抓到 2 篇。加新符號時務必回頭重掃全書。
 *
 * ⚠️ 標記行的**前一行**是那篇的標題，而且標題與標記之間沒有空行，
 * 所以一般的「前後空行短行」判斷抓不到它，要特別處理。
 *
 * 所以偵測到 `◎ 姓名` 就把該小節標題前綴成【他人敘述．姓名】，
 * 而 lib/persona-prompt.ts 有一條對應規則要求她講成「這是某某人談我的部分」。
 * 兩邊是一組的，改一邊記得改另一邊。
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const KNOWLEDGE_DIR = join(process.cwd(), "content", "knowledge");
const BOOK_TITLE = "我來了！臺灣婦女改變了";
/** 產出檔名的前綴。⚠️ 要排在既有 09-quotes.md 後面 */
const FILE_PREFIX = "10-autobiography-";

/** 小節標題最長幾個字。再長就當成內文，寧可漏抓也不要把整段內文變標題。 */
const MAX_HEADING_CHARS = 28;
/** 一節裡短行佔比超過這個就當成詩，保留斷行 */
const VERSE_SHORT_RATIO = 0.6;
/** 幾個字以下算「短行」 */
const VERSE_SHORT_CHARS = 25;
/** 少於這麼多行就不判定為詩（避免把兩行的過場句誤判） */
const VERSE_MIN_LINES = 4;

interface Section {
  /** 小節標題。null ＝ 章的開頭還沒出現小節 */
  heading: string | null;
  /** 這一節是誰在說話。null ＝ 李元貞本人 */
  speaker: string | null;
  lines: string[];
}

interface Chapter {
  number: number;
  title: string;
  sections: Section[];
}

function extractText(pdfPath: string): string {
  try {
    return execFileSync("pdftotext", ["-enc", "UTF-8", pdfPath, "-"], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      "pdftotext 執行失敗（macOS：brew install poppler）。原始錯誤：" +
        (error instanceof Error ? error.message : String(error))
    );
  }
}

/** 章標題？⚠️ 要吃得下兩位數的第 10 章，也要排除目錄那種帶連續點的行 */
function parseChapterHeading(line: string): { number: number; title: string } | null {
  const s = line.trim();
  if (s.includes("…")) return null; // 目錄
  const m = s.match(/^(\d{1,2})\.\s*(\S.*)$/);
  if (!m) return null;
  const title = m[2].trim();
  // 目錄以外，章標題不會太長；也不會以標點收尾
  if (title.length > 40) return null;
  return { number: Number(m[1]), title };
}

function isPageNumber(line: string): boolean {
  return /^\d{1,3}$/.test(line.trim());
}

/** 前後都是空行的短行 ＝ 小節標題（PDF 裡是底線字，抽出來只剩這個特徵） */
function isHeading(lines: string[], i: number): boolean {
  const s = lines[i].trim();
  if (!s || s.length > MAX_HEADING_CHARS) return false;
  if (isPageNumber(s)) return false;
  if ("。，、；：？！）」』…".includes(s[s.length - 1])) return false;
  const prev = i > 0 ? lines[i - 1].trim() : "";
  const next = i + 1 < lines.length ? lines[i + 1].trim() : "";
  return prev === "" && next === "";
}

/**
 * `⊙ 吳瑪悧` / `☉ 譚湘華` / `◎范巽綠` → 姓名。
 * ⚠️ 三個符號是不同碼位，見檔頭。`◎范巽綠` 沒有空格，所以 \s* 不能寫成 \s+。
 */
function parseSpeaker(line: string): string | null {
  const m = line.trim().match(/^[◎⊙☉]\s*(\S.*)$/);
  if (!m) return null;
  // 「劉毓秀談李元貞」這種寫法只取人名
  return m[1].trim().replace(/談李元貞$/, "").trim();
}

/** 這一節是詩嗎？詩的行不可以接起來。 */
function looksLikeVerse(lines: string[]): boolean {
  const body = lines.filter((l) => l.trim());
  if (body.length < VERSE_MIN_LINES) return false;
  const short = body.filter((l) => l.trim().length <= VERSE_SHORT_CHARS).length;
  return short / body.length >= VERSE_SHORT_RATIO;
}

/**
 * 把硬換行的段落接回去。
 * ⚠️ 中文沒有詞間空格，直接相接就對了；加空格反而會在句子中間插洞。
 */
function joinParagraphs(lines: string[]): string[] {
  const paragraphs: string[] = [];
  let current = "";
  for (const line of lines) {
    const s = line.trim();
    if (!s) {
      if (current) paragraphs.push(current);
      current = "";
      continue;
    }
    current += s;
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

/** 詩：保留斷行，但空行仍然分段（一首詩一個段落） */
function keepVerse(lines: string[]): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) {
      if (current.length) blocks.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(s);
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

function parseChapters(text: string): Chapter[] {
  const raw = text.split("\n");

  // 頁碼與換頁字元先清掉，但**保留空行**——空行是段落分界
  const lines = raw
    .map((l) => l.replace(/\f/g, "").replace(/ /g, " "))
    .filter((l) => !isPageNumber(l));

  const chapters: Chapter[] = [];
  let chapter: Chapter | null = null;
  let section: Section | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const s = line.trim();

    const head = parseChapterHeading(line);
    if (head) {
      chapter = { number: head.number, title: head.title, sections: [] };
      chapters.push(chapter);
      section = { heading: null, speaker: null, lines: [] };
      chapter.sections.push(section);
      continue;
    }
    if (!chapter || !section) continue; // 封面與目錄

    const speaker = parseSpeaker(line);
    if (speaker) {
      const open: Section = section;
      // 標記行的前一行是這篇的標題，而且中間沒有空行——一般的標題判斷抓不到。
      // 所以在這裡自己開一節，並把已經被當成內文吃進去的那一行拿回來當標題。
      let heading: string | null = null;
      for (let k = open.lines.length - 1; k >= 0; k--) {
        const prev = open.lines[k].trim();
        if (!prev) continue;
        if (prev.length <= MAX_HEADING_CHARS) {
          heading = prev;
          open.lines.splice(k, 1);
        }
        break;
      }
      section = { heading, speaker, lines: [] };
      chapter.sections.push(section);
      continue;
    }

    if (isHeading(lines, i)) {
      section = { heading: s, speaker: null, lines: [] };
      chapter.sections.push(section);
      continue;
    }

    section.lines.push(line);
  }

  return chapters;
}

function renderChapter(chapter: Chapter): string {
  const parts: string[] = [];
  parts.push("---");
  parts.push(`source: ${BOOK_TITLE}`);
  parts.push("sourceUrl: ");
  parts.push(`title: 第 ${chapter.number} 章 ${chapter.title}`);
  parts.push("---");
  parts.push("");
  parts.push(`# 第 ${chapter.number} 章 ${chapter.title}`);
  parts.push("");

  for (const section of chapter.sections) {
    const blocks = looksLikeVerse(section.lines)
      ? keepVerse(section.lines)
      : joinParagraphs(section.lines);
    if (!blocks.length) continue;

    if (section.heading || section.speaker) {
      // 🔴 他人敘述一定要標出來，見檔頭
      const label = section.speaker
        ? `【他人敘述．${section.speaker}】${section.heading ?? ""}`.trim()
        : section.heading!;
      parts.push(`## ${label}`);
      parts.push("");
    }

    if (section.speaker) {
      // 除了標題，內文開頭也放一句——檢索命中的是「塊」，塊不一定帶得到標題
      parts.push(
        `（以下這一節是 ${section.speaker} 以第一人稱談李元貞，不是李元貞本人的話。）`
      );
      parts.push("");
    }

    for (const block of blocks) {
      parts.push(block);
      parts.push("");
    }
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) throw new Error("用法：npx tsx scripts/import-autobiography.ts <PDF 路徑>");

  console.log("讀取 PDF…");
  const text = extractText(pdfPath);
  console.log(`  取到 ${text.length.toLocaleString()} 字`);

  const chapters = parseChapters(text);
  if (!chapters.length) throw new Error("一章都沒解析出來，不寫檔");
  console.log(`解析出 ${chapters.length} 章`);

  // 舊的產出先清掉，免得改了章數之後留下孤兒檔
  for (const file of readdirSync(KNOWLEDGE_DIR)) {
    if (file.startsWith(FILE_PREFIX)) unlinkSync(join(KNOWLEDGE_DIR, file));
  }

  let guestSections = 0;
  for (const chapter of chapters) {
    const body = renderChapter(chapter);
    const name = `${FILE_PREFIX}${String(chapter.number).padStart(2, "0")}.md`;
    writeFileSync(join(KNOWLEDGE_DIR, name), body, "utf-8");

    const guests = chapter.sections.filter((s) => s.speaker);
    guestSections += guests.length;
    const verse = chapter.sections.filter((s) => looksLikeVerse(s.lines)).length;
    console.log(
      `  ✅ ${name}  第 ${chapter.number} 章 ${chapter.title}` +
        `　${body.length.toLocaleString()} 字／${chapter.sections.length} 節` +
        (verse ? `／詩 ${verse} 節` : "") +
        (guests.length ? `／🔴 他人敘述 ${guests.length} 節（${guests.map((g) => g.speaker).join("、")}）` : "")
    );
  }

  console.log(`\n完成。他人敘述共 ${guestSections} 節——這些是必須標記的，見檔頭說明。`);
  console.log("接下來：npm run build:index && npm run ingest:supabase");
}

main();
