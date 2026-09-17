/**
 * 把《我來了！臺灣婦女改變了》的 PDF 轉成 content/knowledge/ 底下的 markdown。
 *
 * 用法：
 *   npx tsx scripts/import-autobiography.ts "/path/to/我來了_內文all-L-確認用.pdf"
 *
 * 這是**一次性的匯入工具**，不是每次 build 都會跑的東西。轉完之後產出的 .md
 * 就是語料本體，之後要修內容直接改 .md，不要回頭改這支再重跑
 * （重跑會蓋掉人工修過的地方）。
 *
 * ⚠️ 需要 poppler 的 `pdftotext`（macOS：brew install poppler）。
 * 沒有它就直接失敗，不要靜默產出空檔——空語料會讓整站的檢索全滅。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 2026-09-17 改版：改吃「定稿校樣 PDF」，整支重寫取文層
 * ═══════════════════════════════════════════════════════════════════
 *
 * 舊版吃的是 266 頁的單頁 PDF，`pdftotext <pdf> -` 直接取文即可。
 * 定稿版（197 頁）換成了**跨頁排版**：一張 PDF 頁 = 左右兩個印刷頁並排
 * （850×595 pt，寬高比 1.43）。直接 pdftotext 會把左右兩頁的同一列接成
 * 一行，產出的是**語意亂碼，而且不會報錯**。實測與既有語料的 120 字連續
 * 視窗命中率：直接取文 0%、`-layout` 0%、左右分開再合併 68%。
 *
 * 🔴 更麻煩的是：定稿版的**段落分界在純文字裡完全消失**。
 * 中文書的段落是用「首行縮排兩個字」表示的，這一版的行距又沒有加大，
 * 所以 pdftotext 的純文字輸出裡，段落之間沒有空行、也沒有縮排空白
 * （縮排被 pdftotext 吃掉了）。同樣地，小節標題在純文字裡只剩「前面有
 * 一個空行」——後面沒有空行，舊版 `isHeading()` 的「前後都是空行」判斷
 * 在新版會抓到 **0 個標題**，整章會變成一個沒有標題、段落全黏在一起的
 * 巨大字串，而且同樣不會報錯。
 *
 * 所以這一版改用 `pdftotext -bbox-layout`，拿每一行的座標與字級來重建結構：
 *
 *   ┌ 版面事實（2026-09-17 對定稿 PDF 實測）────────────────────────┐
 *   │ 左頁文字左邊界 x=56.7、右頁 x=496.1（右頁靠訂口所以內縮較多）  │
 *   │ 段落首行縮排 +22.7 pt（＝兩個字），續行回到左邊界              │
 *   │ 行距 19.5 pt                                                  │
 *   │ 頁尾（頁碼＋書眉）在 y > 高度的 93%                            │
 *   │ 書眉長這樣：`5擎起婦運火炬`——**章號＋章名都在裡面**           │
 *   │ 字級（行高）分層：                                            │
 *   │   ≥26  章名頁的美術字（`1` / `眷村歲月 —`）→ 丟掉             │
 *   │   20.3 大標（一般小節標題）                                   │
 *   │   13.7 中標（詩題、他人專文的篇名）                            │
 *   │   12.6 中標（另一種樣式）                                      │
 *   │   11.6 內文級（**只出現在他人專文內部的子標題**）              │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * ⚠️ 跨頁與否是**自動判斷**的（寬高比 > 1.2 才切左右），不是寫死的。
 * 這支之後可能拿去跑單頁版 PDF；而且這本書的第 1 頁（封面）本身就是
 * 單頁寬，混在跨頁檔裡——切左右時左半正好涵蓋整頁、右半是空的，
 * `left + right` 仍然等於整頁，所以不需要特例。
 *
 * ── 🔴 他人第一人稱專文 ─────────────────────────────────────────
 *
 * 書裡不是每一段都是李元貞在說話。**定稿版把署名格式整個換掉了**：
 *
 *     舊版（266 頁）      李元貞，我的一盞明燈
 *                        ◎ 譚湘華          ← ⊙ U+2299／☉ U+2609／◎ U+25CE
 *
 *     定稿版（197 頁）    李元貞，我的一盞明燈
 *                        —譚湘華           ← 破折號，且整行靠右對齊
 *
 * 定稿版全書 ◎⊙☉ 出現 **0 次**。舊的 `/^[◎⊙☉]\s*(\S.*)$/` 在新版會抓到
 * **0 篇**，13 篇他人敘述會全部失去【他人敘述】標記。後果很具體：
 * 數位李元貞會用她的臉和克隆聲音說「我選上立委」「我擔任行政院副院長」。
 *
 * 所以 `parseSpeaker()` **同時支援兩種格式**（舊檔可能還會拿來跑）：
 *   - 舊：圈點符號開頭
 *   - 新：**整行只有破折號 ＋ 2~5 個中文字**。破折號有多種碼位（— – ― ─ ー -）
 *     要全部涵蓋，但判準必須是「整行就只有這些」——章名
 *     「眷村歲月—鐵絲網圈住的童年」也含破折號，不能誤抓。
 *
 * 定稿版全書掃出來剛好 13 位，與人工核對一致：
 *   譚湘華、聶湖濱、吳瑪悧、黎煥雄、黃瓊華、林絲緞、李豐（🔴 定稿版新增）、
 *   施寄青、葉菊蘭、蘇芊玲、劉毓秀、范巽綠、李元晶
 * （舊版有、定稿版**刪掉**的陳建志專文不在此列——這是出版方的編輯決定。）
 *
 * ⚠️ 舊版靠兩張人工覆寫表（GUEST_CONTINUATION / GUEST_INLINE_SWITCH）補救
 * 「專文被子標題截斷後 speaker 掉回 null」的問題。**這一版已經刪掉那兩張表**，
 * 理由是定稿版的字級分層提供了結構性的解法，實際比對過產出：
 *   - 葉菊蘭那篇的三個子標題（成長的啟蒙與職場的尊嚴／國會與憲政戰場上的
 *     老姐妹／先行者的歷史拓印）在定稿版是 **11.6 pt 的內文級標題**，
 *     而下一個真正屬於李元貞的段落標題「「婦女新知基金會」成立」是
 *     **20.3 pt 的大標**。
 *   - 全書 11.6 pt 的標題**只出現在他人專文內部**（黎煥雄 3 個、黃瓊華 2 個、
 *     李豐 2 個、葉菊蘭 3 個、范巽綠 2 個、劉毓秀 3 個），沒有例外。
 * 所以規則改成「**他人專文延續到下一個大標（20.3 pt）為止**」，
 * 13 篇的起訖逐篇核對過都正確，不再需要人工表。加新專文時不用改程式。
 *
 * ── 定稿版相對舊語料的增刪（已逐段比對）──────────────────────────
 *
 * 收進來：作者序（末段有新增）、李豐專文〈助人最樂—我與元貞〉、致謝、
 *         附錄一李元貞年表、附錄二臺灣婦女權益進展大事紀
 * 不收：  目錄、出版序、推薦序 ×3（黃長玲／黃明川／苗博雅）
 *         —— 那是別人稱讚她的文字，收進去她會開始引用對自己的讚美。
 *         書末的圖片集（圖說）與版權頁也不收；圖說裡也有「黃長玲」。
 * 定稿版已刪（所以新語料不該出現，這是驗收項）：
 *         陳建志專文、「鄉土文學論戰」整節（〈狼來了〉／王拓／楊青矗／
 *         陳映真在定稿 PDF 裡出現 0 次）。
 *
 * 附錄的切塊策略見 `renderAppendix()` 的說明。
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const KNOWLEDGE_DIR = join(process.cwd(), "content", "knowledge");
const BOOK_TITLE = "我來了！臺灣婦女改變了";
/** 產出檔名的前綴。⚠️ 要排在既有 09-quotes.md 後面 */
const FILE_PREFIX = "10-autobiography-";

/** 跨頁排版的判準：寬高比超過這個就當成「兩個印刷頁並排」 */
const SPREAD_RATIO = 1.2;
/** 頁尾（頁碼＋書眉）從頁高的幾成開始 */
const FOOTER_FROM = 0.93;
/** 行高超過這個 pt 就是章名頁的美術字，不是內文（實測大標只有 20.3） */
const DISPLAY_HEIGHT = 26;
/** 大標的行高下限。他人專文延續到下一個大標為止，靠這條界定 */
const MAJOR_HEADING_HEIGHT = 18;
/** 段落首行縮排的下限 / 上限（實測正好 22.7 ＝ 兩個字） */
const INDENT_MIN = 10;
const INDENT_MAX = 60;
/** y 差小於這個就是「同一個視覺行被拆成好幾段」，要接回去而不是當新行 */
const SAME_LINE_EPS = 2;
/**
 * 小節標題最長幾個字。再長就當成內文，寧可漏抓也不要把整段內文變標題。
 * ⚠️ 定稿版滿版一行是 26~27 字，而全書最長的真標題是 18 字。抓 28 的話，
 * 頁首那種「剛好收尾在 26 字」的內文續行會被誤判成標題。
 */
const MAX_HEADING_CHARS = 22;
/** 標題前面的空白要大於「行距 × 這個倍數」 */
const HEADING_GAP_FACTOR = 1.35;
/** 連續幾行都縮排就當成詩（詩每一行都縮排，散文只有首行縮排） */
const VERSE_MIN_LINES = 3;
/** 幾個字以下算「短行」 */
const VERSE_SHORT_CHARS = 25;
/** 一段詩裡短行佔比要超過這個（擋掉連續好幾個單行短段落被誤判成詩） */
const VERSE_SHORT_RATIO = 0.6;

/** 一個「邏輯行」：同一個 y 上的碎片已經接起來了 */
interface Line {
  /** 相對於該半頁文字左邊界的水平位移。0 ＝ 續行，+22.7 ＝ 段落首行 */
  dx: number;
  y: number;
  /** 與上一行的 y 差。null ＝ 該半頁的第一行 */
  gap: number | null;
  /** 行高，拿來當字級用 */
  height: number;
  text: string;
}

/** 一個印刷頁（跨頁檔裡是半張 PDF 頁） */
interface Page {
  pdfPage: number;
  side: "L" | "R";
  /** 頁尾印的頁碼 */
  printed: number | null;
  /** 書眉，例如 `5擎起婦運火炬`。只印在單數頁（右半），偶數頁是空的 */
  runningHead: string;
  lines: Line[];
  /** 算完全書左邊界之前的暫存 */
  raw: RawLine[];
}

interface Section {
  /** 小節標題。null ＝ 這一節還沒出現標題 */
  heading: string | null;
  /** 這一節是誰在說話。null ＝ 李元貞本人 */
  speaker: string | null;
  /** 標題的字級層級：1 ＝ 大標，2 ＝ 中標，3 ＝ 內文級 */
  level: number;
  blocks: Block[];
}

type Block = { kind: "prose" | "verse"; text: string };

interface Doc {
  /** 檔名的數字後綴 */
  index: number;
  title: string;
  sections: Section[];
  /** 附錄用：年份 → 條目。有值時走 renderAppendix() */
  entries?: { key: string; lines: string[] }[];
}

// ───────────────────────── 取文 ─────────────────────────

/**
 * `pdftotext -bbox-layout` 的 XHTML → 每一行的座標、字級、文字。
 *
 * ⚠️ `<word>` 之間的空白在 bbox 輸出裡是丟失的（每個 word 是獨立標籤），
 * 但 pdftotext 切 word 的界線**就是**它在純文字模式會放空白的地方，
 * 所以用單一空白接回去，結果與純文字輸出一致
 * （`1976` + `年結束…` → `1976 年結束…`、`給` `C.` `L.` → `給 C. L.`）。
 * 中文之間不會被切開，所以不會在句子中間插洞。
 */
function extractPdf(pdfPath: string): {
  pages: { width: number; height: number; lines: RawLine[] }[];
} {
  let xml: string;
  try {
    xml = execFileSync("pdftotext", ["-bbox-layout", "-enc", "UTF-8", pdfPath, "-"], {
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      "pdftotext 執行失敗（macOS：brew install poppler）。原始錯誤：" +
        (error instanceof Error ? error.message : String(error))
    );
  }

  const pages: { width: number; height: number; lines: RawLine[] }[] = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  const lineRe =
    /<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/line>/g;
  const wordRe = /<word[^>]*>([^<]*)<\/word>/g;

  for (let pm = pageRe.exec(xml); pm; pm = pageRe.exec(xml)) {
    const lines: RawLine[] = [];
    const inner = pm[3];
    lineRe.lastIndex = 0;
    for (let lm = lineRe.exec(inner); lm; lm = lineRe.exec(inner)) {
      const words: string[] = [];
      wordRe.lastIndex = 0;
      for (let wm = wordRe.exec(lm[5]); wm; wm = wordRe.exec(lm[5])) {
        if (wm[1]) words.push(decodeEntities(wm[1]));
      }
      const text = words.join(" ").replace(/\u00a0/g, " ").trim();
      if (!text) continue;
      lines.push({
        xMin: Number(lm[1]),
        yMin: Number(lm[2]),
        yMax: Number(lm[4]),
        text,
      });
    }
    pages.push({ width: Number(pm[1]), height: Number(pm[2]), lines });
  }

  if (!pages.length) throw new Error("pdftotext 一頁都沒讀到，不往下走");
  return { pages };
}

interface RawLine {
  xMin: number;
  yMin: number;
  yMax: number;
  text: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/**
 * 把 PDF 頁切成「印刷頁」。跨頁排版 → 左右各一；單頁排版 → 原樣一頁。
 *
 * ⚠️ 判準是**每一頁自己的**寬高比，不是整份檔案的。這本書第 1 頁是單頁寬、
 * 其餘是跨頁寬；混著也不會出事，因為單頁時右半沒有任何行。
 */
function splitPages(raw: { width: number; height: number; lines: RawLine[] }[]): Page[] {
  const pages: Page[] = [];

  for (let i = 0; i < raw.length; i++) {
    const { width, height, lines } = raw[i];
    const spread = width / height > SPREAD_RATIO;
    const half = spread ? width / 2 : width;
    const sides: ("L" | "R")[] = spread ? ["L", "R"] : ["L"];

    for (const side of sides) {
      const lo = side === "L" ? 0 : half;
      const hi = side === "L" ? half : width;
      const mine = lines.filter((l) => l.xMin >= lo && l.xMin < hi);

      const footer = mine.filter((l) => l.yMin > height * FOOTER_FROM);
      const body = mine
        .filter((l) => l.yMin <= height * FOOTER_FROM)
        // 章名頁的美術字（`1` / `眷村歲月 —`）——章名另外從書眉拿，這裡丟掉
        .filter((l) => l.yMax - l.yMin < DISPLAY_HEIGHT)
        .sort((a, b) => a.yMin - b.yMin || a.xMin - b.xMin);

      pages.push({
        pdfPage: i + 1,
        side,
        ...readFooter(footer, side, lo, hi),
        raw: body,
        lines: [],
      });
    }
  }

  // 🔴 文字左邊界要用**全書同一側**的眾數，不能每頁各算一次。
  // 每頁各算的話，詩佔多數的版面（第 6 章整章都是）眾數會落在「縮排」那一欄，
  // 於是詩題變成「有縮排」、詩句變成「貼邊」——判斷整個反過來，
  // 該章的詩題會全部漏抓（實測第 6 章 32 個標題只剩 17 個），而且不會報錯。
  const base: Record<string, number> = {};
  for (const side of ["L", "R"]) {
    const all = pages.filter((p) => p.side === side).flatMap((p) => p.raw);
    base[side] = modalX(all, 0);
  }
  for (const page of pages) {
    page.lines = toLines(page.raw, base[page.side]);
    page.raw = [];
  }

  return pages;
}

/**
 * 頁尾拆成「頁碼」與「書眉」。
 *
 * ⚠️ 書眉裡也有數字（章號），不能看到數字就當頁碼——第一版就是這樣把
 * `5擎起婦運火炬` 的 `5` 當成頁碼、章號整個掉了。頁碼永遠靠**外側**
 * （左頁靠左、右頁靠右），書眉在版心裡，所以用位置分。
 */
function readFooter(
  footer: RawLine[],
  side: "L" | "R",
  lo: number,
  hi: number
): { printed: number | null; runningHead: string } {
  const sorted = [...footer].sort((a, b) => a.xMin - b.xMin);
  const numeric = sorted.filter((l) => /^\d{1,4}$/.test(l.text.replace(/\s/g, "")));
  if (!numeric.length) {
    return { printed: null, runningHead: sorted.map((l) => l.text.replace(/\s/g, "")).join("") };
  }
  // 靠外側的那個數字才是頁碼
  const outer = side === "L" ? numeric[0] : numeric[numeric.length - 1];
  const rest = sorted.filter((l) => l !== outer);
  return {
    printed: Number(outer.text.replace(/\s/g, "")),
    runningHead: rest.map((l) => l.text.replace(/\s/g, "")).join(""),
  };
}

/**
 * RawLine[] → Line[]：同一個 y 上的碎片接成一個邏輯行，並算出 dx 與行距。
 *
 * ⚠️ 為什麼要接：內文裡引詩會把詩句排在同一行上、彼此拉開距離，
 * pdftotext 會吐成好幾個 `<line>`。不接的話，中間那段的 xMin 看起來就像
 * 「段落縮排」，整段會被切成好幾個假段落。
 */
function toLines(body: RawLine[], base: number): Line[] {
  const out: Line[] = [];
  let prevY: number | null = null;

  for (const raw of body) {
    const last = out[out.length - 1];
    if (last && Math.abs(raw.yMin - last.y) < SAME_LINE_EPS) {
      last.text += " " + raw.text;
      last.dx = Math.min(last.dx, raw.xMin - base);
      last.height = Math.max(last.height, raw.yMax - raw.yMin);
      continue;
    }
    out.push({
      dx: raw.xMin - base,
      y: raw.yMin,
      gap: prevY === null ? null : raw.yMin - prevY,
      height: raw.yMax - raw.yMin,
      text: raw.text,
    });
    prevY = raw.yMin;
  }
  return out;
}

/** 文字左邊界＝出現最多次的 xMin（散文續行都貼著它，所以全書統計一定最多） */
function modalX(body: RawLine[], lo: number): number {
  if (!body.length) return lo;
  const count = new Map<number, number>();
  for (const l of body) {
    const k = Math.round(l.xMin * 2) / 2;
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  let best = body[0].xMin;
  let bestN = -1;
  count.forEach((n, k) => {
    if (n > bestN || (n === bestN && k < best)) {
      best = k;
      bestN = n;
    }
  });
  return best;
}

// ───────────────────────── 結構判讀 ─────────────────────────

/**
 * 章標題？兩種寫法都吃：
 *   `1. 眷村歲月——鐵絲網圈住的童年`（舊版 PDF 正文）
 *   `1 眷村歲月—鐵絲網圈住的童年`（定稿版目錄與書眉）
 * ⚠️ 要吃得下兩位數的第 10 章，也要排除目錄那種帶連續點的行。
 */
export function parseChapterHeading(line: string): { number: number; title: string } | null {
  const s = line.trim();
  if (s.includes("…")) return null; // 目錄
  const m = s.match(/^(\d{1,2})[.\s　]*\s*(\S.*)$/);
  if (!m) return null;
  const title = m[2].trim();
  // 目錄以外，章標題不會太長；也不會以標點收尾
  if (!title || title.length > 40) return null;
  if (/^\d/.test(title)) return null; // `2026 年 9 月` 這種不是章標題
  return { number: Number(m[1]), title };
}

/** 破折號的各種碼位。定稿版署名用的是 U+2014，但不同輸出可能換成別的 */
const DASHES = "—–―─ー-";

/**
 * 署名行 → 姓名。兩種格式都支援：
 *   舊版：`⊙ 吳瑪悧` / `☉ 譚湘華` / `◎范巽綠`（三個不同碼位，見檔頭）
 *   定稿版：`—譚湘華` / `— 黃瓊華`
 *
 * 🔴 定稿版的判準是「**整行**只有破折號＋2~5 個中文字」，不是「行內含破折號」。
 * 章名「眷村歲月—鐵絲網圈住的童年」也有破折號，用寬鬆判準會誤抓。
 */
export function parseSpeaker(line: string): string | null {
  const s = line.trim();
  const legacy = s.match(/^[◎⊙☉]\s*(\S.*)$/);
  if (legacy) return legacy[1].trim().replace(/談李元貞$/, "").trim();
  const dashed = s.match(new RegExp(`^[${DASHES}]\\s*([\\u4e00-\\u9fff]{2,5})$`));
  return dashed ? dashed[1] : null;
}

/** 這一行是標題嗎？回傳字級層級（1 大標 / 2 中標 / 3 內文級），不是標題就 null */
function headingLevel(lines: Line[], i: number, leading: number): number | null {
  const l = lines[i];
  const s = l.text.trim();
  if (!s || s.length > MAX_HEADING_CHARS) return null;
  if (/^\d{1,4}$/.test(s)) return null; // 落單的頁碼之類
  // 收尾是句末標點就是內文，不是標題。
  // ⚠️ 要先剝掉右引號再看：`我倒是可以盡我的能力。」` 是內文（剝完是「。」），
  // 但 `「詩社」與「文社」` 是真標題（剝完是「社」）——只看最後一個字會把後者一起殺掉。
  const tail = s.replace(/[）」』〉》\]]+$/, "");
  if (!tail || "。，、；：？！…".includes(tail[tail.length - 1])) return null;
  // 標題不縮排（縮排的是段落首行）
  if (l.dx > INDENT_MIN) return null;
  // 前面要有明顯的空白；該半頁的第一行沒有上一行可比，放行
  if (l.gap !== null && l.gap <= leading * HEADING_GAP_FACTOR) return null;
  // 標題後面一定接著一個**新段落**（＝縮排的首行）。
  // ⚠️ 上下限都要卡：他人專文的篇名後面接的是靠右對齊的署名行（dx 約 240），
  // 只卡下限的話篇名會被當成一般標題吃掉，署名行就找不到篇名了。
  const next = lines[i + 1];
  if (!next || next.dx < INDENT_MIN || next.dx > INDENT_MAX) return null;
  if (l.height >= MAJOR_HEADING_HEIGHT) return 1;
  if (l.height >= 12.2) return 2;
  return 3;
}

/** 這一行是內文的行距嗎——用眾數估，跨頁 / 附錄的行距不一樣 */
function estimateLeading(pages: Page[]): number {
  const count = new Map<number, number>();
  for (const p of pages) {
    for (const l of p.lines) {
      if (l.gap === null) continue;
      const k = Math.round(l.gap * 2) / 2;
      if (k <= 0) continue;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  let best = 19.5;
  let bestN = -1;
  count.forEach((n, k) => {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  });
  return best;
}

// ───────────────────────── 分段 / 詩 ─────────────────────────

/**
 * 一節的行 → 段落 / 詩。
 *
 * 散文：**首行縮排、續行貼左邊界**。所以「縮排行」開新段，「貼邊行」接上去。
 * 詩：**每一行都縮排**。所以連續 N 行都縮排就是詩，整段保留斷行。
 *
 * ⚠️ 中文沒有詞間空格，續行直接相接就對了；加空格反而會在句子中間插洞。
 */
function toBlocks(lines: Line[], leading: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  const isIndent = (l: Line) => l.dx >= INDENT_MIN && l.dx <= INDENT_MAX;
  const isFlush = (l: Line) => l.dx < INDENT_MIN;

  while (i < lines.length) {
    if (!isIndent(lines[i])) {
      // 靠右對齊的落款／日期（`1965 年 5 月 10 日`）自成一段
      if (!isFlush(lines[i])) {
        blocks.push({ kind: "prose", text: lines[i].text.trim() });
        i += 1;
        continue;
      }
      // 沒有首行縮排就開始的續行（章／節的第一段常常這樣）→ 當新段落
      let text = "";
      while (i < lines.length && isFlush(lines[i])) text += lines[i++].text.trim();
      if (text) blocks.push({ kind: "prose", text });
      continue;
    }

    // 從這裡開始的一串縮排行有多長？
    let j = i;
    while (j < lines.length && isIndent(lines[j])) j += 1;
    const run = lines.slice(i, j);

    if (isVerse(run)) {
      // 詩：保留斷行；行距明顯拉開的地方分節
      const stanzas: string[][] = [[]];
      for (const l of run) {
        if (stanzas[stanzas.length - 1].length && l.gap !== null && l.gap > leading * 1.35) {
          stanzas.push([]);
        }
        stanzas[stanzas.length - 1].push(l.text.trim());
      }
      for (const st of stanzas) if (st.length) blocks.push({ kind: "verse", text: st.join("\n") });
      i = j;
      continue;
    }

    // 散文：每個縮排行開一段，後面的貼邊行接上去
    for (const l of run) blocks.push({ kind: "prose", text: l.text.trim() });
    // 續行接到最後一段
    i = j;
    while (i < lines.length && isFlush(lines[i])) {
      blocks[blocks.length - 1].text += lines[i].text.trim();
      i += 1;
    }
  }

  return blocks.filter((b) => b.text.trim());
}

/** 一串全部縮排的行是詩嗎？行數夠多、而且大多是短行 */
function isVerse(run: Line[]): boolean {
  if (run.length < VERSE_MIN_LINES) return false;
  const short = run.filter((l) => l.text.trim().length <= VERSE_SHORT_CHARS).length;
  return short / run.length >= VERSE_SHORT_RATIO;
}

// ───────────────────────── 分節 ─────────────────────────

/**
 * 一段連續的印刷頁 → 小節。
 *
 * 🔴 他人專文的範圍：從署名行往下，**一路延續到下一個大標（20.3 pt）為止**。
 * 專文內部的子標題在定稿版是 11.6 pt 的內文級標題，不會打斷專文。
 * 詳見檔頭「他人第一人稱專文」那一段的實測依據。
 */
function buildSections(pages: Page[], leading: number): Section[] {
  const sections: Section[] = [];
  let cur: Section = { heading: null, speaker: null, level: 0, blocks: [] };
  let pending: Line[] = [];
  /** 目前正在進行中的他人專文的講者 */
  let guest: string | null = null;

  const flush = () => {
    cur.blocks = toBlocks(pending, leading);
    if (cur.blocks.length || cur.heading) sections.push(cur);
    pending = [];
  };

  /** 上一個印刷頁的最後一行——用來判斷這一頁的第一行是不是「接著講」 */
  let carried: string | null = null;

  for (const page of pages) {
    const lines = page.lines;
    // 🔴 頁首那一行沒有「上一行」可比行距，所以標題判斷對它特別寬鬆。
    // 但上一頁如果沒把句子講完，這一行就一定是續行，不可能是標題。
    if (lines.length && carried !== null && !/[。！？」』）…]$/.test(carried)) {
      lines[0] = { ...lines[0], gap: 0 };
    }
    carried = lines.length ? lines[lines.length - 1].text.trim() : carried;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const speaker = parseSpeaker(line.text);
      if (speaker) {
        // 署名行的**前一行**是這篇的篇名，而且中間沒有大空白——
        // 一般的標題判斷抓不到（篇名可能以「！」「」」收尾）。
        // 所以在這裡自己開一節，把已經吃進去的那一行拿回來當標題。
        let heading: string | null = null;
        for (let k = pending.length - 1; k >= 0; k--) {
          const prev = pending[k].text.trim();
          if (!prev) continue;
          if (prev.length <= MAX_HEADING_CHARS) {
            heading = prev;
            pending.splice(k, 1);
          }
          break;
        }
        // 篇名剛好被當成標題吃進去、還沒有任何內文時（篇名在頁首時會這樣），
        // 直接把那個標題接手過來——否則整篇會變成沒有篇名的【他人敘述．某某】。
        if (!heading && !pending.length && cur.heading) {
          heading = cur.heading;
          cur = { heading: null, speaker: cur.speaker, level: 0, blocks: [] };
        }
        flush();
        guest = speaker;
        cur = { heading, speaker, level: 2, blocks: [] };
        continue;
      }

      const level = headingLevel(lines, i, leading);
      if (level !== null) {
        // 大標結束他人專文；中標／內文級標題留在專文裡面
        if (level === 1) guest = null;
        flush();
        cur = { heading: line.text.trim(), speaker: guest, level, blocks: [] };
        continue;
      }

      pending.push(line);
    }
  }

  flush();

  // 🔴 篇名後面**緊接著**就是子標題時（黎煥雄那篇），篇名那一節沒有任何內文，
  // 算出來會是一個空節——`renderDoc()` 會把空節整個跳過，篇名就消失了。
  // 把它併進下一節的標題，篇名才會進到麵包屑、被 embedding 帶到。
  const merged: Section[] = [];
  for (const section of sections) {
    const prev = merged[merged.length - 1];
    if (prev && !prev.blocks.length && prev.heading && prev.speaker === section.speaker) {
      merged[merged.length - 1] = {
        ...section,
        heading: section.heading ? `${prev.heading}・${section.heading}` : prev.heading,
      };
      continue;
    }
    merged.push(section);
  }
  return merged;
}

// ───────────────────────── 產出 ─────────────────────────

function frontMatter(title: string): string[] {
  return ["---", `source: ${BOOK_TITLE}`, "sourceUrl: ", `title: ${title}`, "---", "", `# ${title}`, ""];
}

function renderDoc(doc: Doc): string {
  if (doc.entries) return renderAppendix(doc);

  const parts = frontMatter(doc.title);

  for (const section of doc.sections) {
    if (!section.blocks.length) continue;

    if (section.heading || section.speaker) {
      // 🔴 他人敘述一定要標出來，見檔頭
      const label = section.speaker
        ? `【他人敘述．${section.speaker}】${section.heading ?? ""}`.trim()
        : section.heading!;
      parts.push(`## ${label}`, "");
    }

    if (section.speaker) {
      // 除了標題，內文開頭也放一句——檢索命中的是「塊」，塊不一定帶得到標題
      parts.push(
        `（以下這一節是 ${section.speaker} 以第一人稱談李元貞，不是李元貞本人的話。）`,
        ""
      );
    }

    for (const block of section.blocks) parts.push(block.text, "");
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * 附錄（年表／大事紀）的切塊策略。
 *
 * ⚠️ 年表是條列式資料，不是散文。整份灌成一大段的話，`chunkMarkdown` 會把它
 * 當成一個巨大段落，`splitLongParagraph` 只能在句號處硬切，切出來的塊沒有
 * 年份錨點——「李元貞哪一年離婚」這種問題會檢索不到。
 *
 * 所以**一個年份 ＝ 一個 `##` 小節**，該年的所有條目接成一段。
 * `chunkMarkdown` 會把小節標題做成麵包屑（【檔名 · 李元貞年表　1973（27 歲）】）
 * 一起送去 embedding，所以年份同時進了向量與引用標題。
 * 實測每個年份大多 20~200 字，剛好落在 maxChars 400 以內，一年一塊。
 */
function renderAppendix(doc: Doc): string {
  const parts = frontMatter(doc.title);
  for (const entry of doc.entries!) {
    parts.push(`## ${entry.key}`, "");
    parts.push(`${entry.key}　${entry.lines.join("")}`, "");
  }
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * 附錄的兩欄版面 → 年份 ＋ 條目。
 *
 * 版面事實：年份在左邊界外側（dx 約 -14 / -12、字級 14 pt），條目縮排在右邊
 * （年表 dx +56.7、大事紀 dx +24）。年份那一行後面常常**直接接著第一條**，
 * 所以要把它切開。
 */
function parseAppendix(pages: Page[]): { key: string; lines: string[] }[] {
  const out: { key: string; lines: string[] }[] = [];
  const keyRe = /^(\d{4}\s*(?:（\s*\d{1,3}\s*歲\s*）)?)\s*(.*)$/;

  for (const page of pages) {
    // 年份欄的 dx 是該頁最小的那一群
    const minDx = Math.min(...page.lines.map((l) => l.dx));
    for (const line of page.lines) {
      const isKeyColumn = line.dx <= minDx + 3;
      const m = isKeyColumn ? line.text.trim().match(keyRe) : null;
      if (m && /^\d{4}/.test(m[1])) {
        out.push({ key: m[1].replace(/\s+/g, " ").trim(), lines: m[2] ? [m[2].trim()] : [] });
        continue;
      }
      if (!out.length) continue; // 附錄標題那幾行
      out[out.length - 1].lines.push(line.text.trim());
    }
  }
  return out.filter((e) => e.lines.length);
}

// ───────────────────────── 主流程 ─────────────────────────

/** 目錄／出版序／推薦序都在作者序前面，從作者序開始收就自動排除了 */
const PREFACE_MARKER = "｜作者序｜";
const BACK_MATTER: { marker: string; title: string }[] = [
  { marker: "致謝", title: "致謝" },
  { marker: "附錄一", title: "李元貞年表" },
  { marker: "附錄二", title: "一九八○年代至今臺灣婦女權益進展大事紀" },
];
/**
 * 書末圖片集的判準：一個印刷頁裡「排滿一行」的長行少於這麼多條。
 * 圖說每條都短（最多 6 條長行），內文與附錄每頁至少 9 條；版權頁 8 條。
 * 圖說裡也有「黃長玲」，所以這一刀非切不可。
 */
const PROSE_LONG_LINES = 9;
const LONG_LINE_CHARS = 25;

function isProsePage(page: Page): boolean {
  return page.lines.filter((l) => l.text.length >= LONG_LINE_CHARS).length >= PROSE_LONG_LINES;
}

function findPage(pages: Page[], pred: (p: Page) => boolean, from = 0): number {
  for (let i = from; i < pages.length; i++) if (pred(pages[i])) return i;
  return -1;
}

const hasExactLine = (text: string) => (p: Page) =>
  p.lines.some((l) => l.text.trim() === text);

function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) throw new Error("用法：npx tsx scripts/import-autobiography.ts <PDF 路徑>");

  console.log("讀取 PDF…");
  const { pages: rawPages } = extractPdf(pdfPath);
  const spread = rawPages.filter((p) => p.width / p.height > SPREAD_RATIO).length;
  console.log(
    `  ${rawPages.length} 張 PDF 頁（跨頁排版 ${spread} 張）` +
      `／版面 ${rawPages[1]?.width.toFixed(0)}×${rawPages[1]?.height.toFixed(0)} pt`
  );

  const pages = splitPages(rawPages);
  const leading = estimateLeading(pages);
  console.log(`  切出 ${pages.length} 個印刷頁，內文行距 ${leading} pt`);

  // ── 章的界線：書眉裡就有章號與章名 ──
  const openers: { at: number; number: number; title: string }[] = [];
  let cur: number | null = null;
  for (let i = 0; i < pages.length; i++) {
    const head = pages[i].runningHead;
    if (!head) continue;
    const parsed = parseChapterHeading(head);
    if (!parsed || parsed.number === cur) continue;
    cur = parsed.number;
    openers.push({ at: i, number: parsed.number, title: parsed.title });
  }

  // 沒有書眉的 PDF（舊版是單頁排版、沒有書眉）→ 退回用正文的章標題行
  if (!openers.length) {
    for (let i = 0; i < pages.length; i++) {
      for (const line of pages[i].lines) {
        const parsed = parseChapterHeading(line.text);
        if (parsed && parsed.number === (cur ?? 0) + 1) {
          cur = parsed.number;
          openers.push({ at: i, number: parsed.number, title: parsed.title });
        }
      }
    }
    if (openers.length) console.log("  （沒有書眉，改用正文的章標題行分章）");
  }
  if (!openers.length) throw new Error("一章都沒解析出來，不寫檔");

  // ── 作者序與書末 ──
  const prefaceAt = findPage(pages, hasExactLine(PREFACE_MARKER));
  if (prefaceAt === -1) throw new Error(`找不到「${PREFACE_MARKER}」，不確定該從哪裡開始收，不寫檔`);
  if (prefaceAt >= openers[0].at) throw new Error("作者序落在第 1 章之後，版面判讀有問題，不寫檔");

  const backStarts = BACK_MATTER.map((b, k) =>
    findPage(pages, hasExactLine(b.marker), k === 0 ? openers[openers.length - 1].at : 0)
  );
  const firstBack = backStarts.find((x) => x !== -1) ?? pages.length;
  // 圖片集／版權頁：從最後一個書末段落往後找第一個「不像內文」的印刷頁
  const lastBack = backStarts.filter((x) => x !== -1).pop() ?? firstBack;
  let corpusEnd = lastBack;
  while (corpusEnd < pages.length && isProsePage(pages[corpusEnd])) corpusEnd += 1;

  const docs: Doc[] = [];

  // 作者序
  docs.push({
    index: 0,
    title: "作者序—寫自傳之必要",
    sections: buildSections(pages.slice(prefaceAt, openers[0].at), leading),
  });

  // 十章
  for (let k = 0; k < openers.length; k++) {
    const o = openers[k];
    const end = k + 1 < openers.length ? openers[k + 1].at : firstBack;
    docs.push({
      index: o.number,
      title: `第 ${o.number} 章 ${o.title}`,
      sections: buildSections(pages.slice(o.at, end), leading),
    });
  }

  // 致謝 ／ 附錄一 ／ 附錄二
  for (let k = 0; k < BACK_MATTER.length; k++) {
    const start = backStarts[k];
    if (start === -1) continue;
    const nextStart = backStarts.slice(k + 1).find((x) => x !== -1);
    const end = Math.min(nextStart ?? corpusEnd, corpusEnd);
    const slice = pages.slice(start, end);
    const index = openers[openers.length - 1].number + 1 + k;
    if (BACK_MATTER[k].marker.startsWith("附錄")) {
      docs.push({ index, title: BACK_MATTER[k].title, sections: [], entries: parseAppendix(slice) });
    } else {
      docs.push({ index, title: BACK_MATTER[k].title, sections: buildSections(slice, leading) });
    }
  }

  // 舊的產出先清掉，免得改了章數之後留下孤兒檔
  for (const file of readdirSync(KNOWLEDGE_DIR)) {
    if (file.startsWith(FILE_PREFIX)) unlinkSync(join(KNOWLEDGE_DIR, file));
  }

  let guestSections = 0;
  const guestNames: string[] = [];
  for (const doc of docs) {
    const body = renderDoc(doc);
    const name = `${FILE_PREFIX}${String(doc.index).padStart(2, "0")}.md`;
    writeFileSync(join(KNOWLEDGE_DIR, name), body, "utf-8");

    const guests = doc.sections.filter((s) => s.speaker);
    const uniq = guests
      .map((g) => g.speaker!)
      .filter((name, i, all) => all.indexOf(name) === i);
    guestSections += guests.length;
    guestNames.push(...uniq);
    const verse = doc.sections.reduce(
      (n, s) => n + s.blocks.filter((b) => b.kind === "verse").length,
      0
    );
    console.log(
      `  ✅ ${name}  ${doc.title}` +
        `　${body.length.toLocaleString()} 字／` +
        (doc.entries ? `${doc.entries.length} 個年份` : `${doc.sections.length} 節`) +
        (verse ? `／詩 ${verse} 段` : "") +
        (uniq.length ? `／🔴 他人敘述 ${guests.length} 節（${uniq.join("、")}）` : "")
    );
  }

  console.log(
    `\n完成。他人敘述共 ${guestSections} 節／${guestNames.length} 位：${guestNames.join("、")}` +
      `\n這些是必須標記的，見檔頭說明。`
  );
  console.log("接下來：npm run build:index && npm run ingest:supabase");
}

main();
