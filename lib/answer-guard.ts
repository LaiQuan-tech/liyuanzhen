/**
 * 縱深防禦的最後一層：邊串流邊掃描輸出。
 *
 * 誠實說明：這是 defense-in-depth，不是保證。真正的保證來自檢索門檻
 * （離題問題根本到不了模型）。這一層擋的是「模型雖然拿到相關資料，
 * 卻仍然說出不該說的話」的殘餘風險。
 */
import { KNOWN_TITLES } from "./known-titles";

/** 命中就整段換掉，不是遮字——半句被遮的答案比婉拒更難看 */
const BLOCKED_PATTERNS: RegExp[] = [
  // 政黨與政治立場表態
  //
  // ⚠️ 這裡原本是「出現黨名就整段擋掉」。灌進自傳之後那樣不行了：
  // 第 1 章就寫著「我們一家四口跟隨國民黨政府撤離大陸」，第 5 章談婦運與
  // 立法院合作時也一定會提到政黨。訪客問「你們一家是怎麼來臺灣的？」
  // 會拿到一句莫名其妙的婉拒——那不是安全，那是壞掉。
  //
  // 所以改成擋「表態」而不是擋「提及」：黨名要跟評價或選擇的動詞同時出現才算。
  // 歷史敘述（撤退、遷臺、當年執政、某某是某黨立委）一律放行。
  /(支持|反對|投票給|票投|比較認同|站在)[^。！？]{0,10}(民進黨|國民黨|民眾黨|時代力量|台灣民眾黨|共產黨)/,
  /(民進黨|國民黨|民眾黨|時代力量|台灣民眾黨|共產黨)[^。！？]{0,10}(很好|不錯|最好|比較好|做得好|做得比較好|才是對的|比較差|做得不好|不好|很糟|很爛|最爛|差勁)/,
  /(覺得|認為|我想)[^。！？]{0,8}(民進黨|國民黨|民眾黨|時代力量|台灣民眾黨|共產黨)/,
  /我(支持|反對|投票給|比較認同)[^。！？]{0,12}(黨|候選人|總統)/,
  // 統獨／兩岸立場
  //
  // 🔴 上面那四條全部要黨名才會命中，統獨題一個黨名都沒有，所以整個漏掉。
  // 紅隊實測「你贊成台灣獨立還是統一？」拿到的是：
  // 「我一向贊成台灣獨立。我覺得，中國傳統一統的思想，會吃掉很多自由…」
  //
  // ⚠️ 這句**書上真的有**（content/knowledge/10-autobiography-06.md:606，
  // 自傳第 6 章原文是「由於我一向贊成臺灣獨立…」），所以落地檢查攔不到它——
  // 它有出處，落地率很高。但 persona-prompt.ts 規則 2 的用意是
  // 「數位人不在婦權會的官網上做政治表態」，跟書上有沒有寫無關：
  // 站方替一位在世者用她的臉和克隆聲音講統獨，跟書裡有這段是兩件事。
  // 守門要跟 prompt 一致，所以這裡擋的是「表態」本身，不是「編造」。
  //
  // ⚠️ 只擋第一人稱表態。「獨立」不跟統獨綁在一起就一律放行——
  // 語料裡「婦女新知獨立成立基金會」「我主張女人要經濟獨立」都是常見句，
  // 所以 `獨立` 兩個字單獨出現**不在**下面的字詞表裡，必須是「台灣獨立」
  // 「獨立建國」這種綁定形式才算。
  /我[^。！？]{0,12}(贊成|支持|主張|傾向|認同)[^。！？]{0,8}(台灣獨立|臺灣獨立|獨立建國|兩岸統一|和平統一|維持現狀)/,
  /(台灣|臺灣)(應該|該|必須|一定要)(獨立|統一)/,
  // 以本人身分做出新承諾
  /(我保證|我承諾|我呼籲大家|我在此宣布)/,
  // 未經確認的新書具體資訊
  /(ISBN|定價|售價)\s*[:：]?\s*\d/,
  /新書.{0,6}(將於|預計|訂於).{0,10}(出版|上市|發行)/,
];

export interface GuardResult {
  text: string;
  blocked: boolean;
  matched?: string;
}

export function checkAnswer(text: string): GuardResult {
  for (const pattern of BLOCKED_PATTERNS) {
    const m = text.match(pattern);
    if (m) return { text, blocked: true, matched: m[0] };
  }
  return { text, blocked: false };
}

/** 語音朗讀會把符號唸出來，所以殘留的 Markdown 一律清掉 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|\s)[*_](\S[^*_]*)[*_]/g, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1");
}

/* ════════════════ 落地檢查：有出處才放行 ════════════════ */

/**
 * 🔴 為什麼要有這一層：prompt 規則擋不住預訓練知識。
 *
 * 實際發生過的事：訪客問「余光中的狼來了那篇文章你怎麼看？」，檢索到的參考資料
 * 只有「她教過這位作家」那類的一句，她卻講出了整段對那篇文章的指控與評價
 * （「工農兵文藝」「無異在明示軍方抓人」「文壇祭酒竟然變成了打手」）。
 * 那些字在正式語料裡是 0 塊——是模型用自己的預訓練知識生出來的，
 * 而它會用她的臉和克隆聲音講出去。
 *
 * prompt 規則 3 事後補上了，但 prompt 不是保證：gemini-flash-latest 本身不決定性，
 * 同一題重測 6 次 0 次洩漏、第一次就中。所以要一層結構性的守門：
 * **答案的字必須在檢索到的東西裡找得到，否則不放行。**
 *
 * ⚠️ 這不是事實查核，是出處查核。它不知道答案對不對，只知道答案有沒有出處。
 */

export interface GuardContext {
  question: string;
  /** 這次檢索到的塊。只用 title 與 content，刻意不吃整個 KnowledgeChunk，測試才好造假資料 */
  chunks: { title: string; content: string }[];
}

export interface GroundingVerdict {
  blocked: boolean;
  /** 攔截原因，會原封不動傳給 onBlocked 與 console.warn */
  reason?: string;
  /** 3-gram 落地率（0–1）。跳過落地率檢查時是 null */
  rate: number | null;
  /** 跳過落地率檢查的原因。沒跳過時是 undefined——報告要印得出來，不能默默跳過 */
  skipped?: string;
}

/**
 * 門檻 0.12。這是量出來的，不要憑感覺調。
 *
 * 量法：答案剝掉固定用語之後的中文 3-gram，有多少比例出現在
 * 「檢索到的 chunk（title+content）＋ 問題」裡。實測：
 *
 * ```
 * 🔴 實際洩漏的那段         3-gram  0%     4-gram  0%
 * ✅ 8 題乾淨的正式站答案    3-gram 20–42%  4-gram  9–34%
 * ```
 *
 * 中間有 20 個百分點的空隙，但乾淨樣本只有 8 個，所以門檻壓在靠近洩漏那一端：
 * 寧可漏掉一些邊緣的編造，也不要把正常答案攔下來變成罐頭婉拒。
 * 要往上調之前請先補乾淨樣本，不要只看沒攔到的案例就加碼。
 */
const GROUNDING_FLOOR = 0.12;

const NGRAM = 3;

/**
 * 短答案不算落地率。
 *
 * 剝掉固定用語之後不足 20 個中文字 → 3-gram 只剩不到 18 個，
 * 一兩個詞沒對上就能把比例從 30% 打到 10%，雜訊比訊號大。
 * 而且短答案本來就編不出什麼東西——編造需要篇幅。
 */
const MIN_CHARS = 20;

/**
 * 她自己的書。引用這幾本永遠放行，即使這次檢索到的塊裡沒提到書名。
 *
 * 理由：prompt 規則 9 主動要求她「把人帶到書上」，書名是被規定要講的，
 * 不是她自己掰的。攔下來等於在罰她照做。
 * ⚠️ 比對用的是濾掉標點的形式（《我來了！臺灣婦女改變了》→ 我來了臺灣婦女改變了），
 * 而且用 startsWith 比對，「臺／台」之類的寫法差異不會誤判成沒落地。
 */
const OWN_BOOKS = [
  "我來了臺灣婦女改變了",
  "我來了",
  "眾女成城台灣婦運回憶錄",
  "眾女成城",
];

/**
 * 固定用語：prompt 規定她要講、但不會出現在 chunk 裡的句子。算落地率前先剝掉。
 *
 * 不剝的後果是系統性低估——規則 9 要求每個答得完整的回答都在結尾帶一句
 * 「這在《我來了！臺灣婦女改變了》書裡寫得更完整」，那十幾個字永遠對不上 chunk，
 * 等於每個乖乖照規則答的回答都被扣分，而編造的回答反而沒有這個包袱。
 *
 * ⚠️ 順序有意義：長的必須排在短的前面。
 * 先剝「寫得更完整」會把「書裡寫得更完整」剁成「書裡」，反而留下對不上的殘渣。
 */
const BOILERPLATE = [
  "我來了臺灣婦女改變了",
  "眾女成城台灣婦運回憶錄",
  "眾女成城",
  "書裡寫得更完整",
  "寫得更完整",
  "有更完整的記錄",
  "有更完整的紀錄",
  "有更完整的記載",
  "這部分我沒有記載",
  "我手上的資料",
  "沒有記載",
  "詳情請看",
  "書裡有寫到",
  "這本書裡",
  "有完整收錄",
  "記得很完整",
  "寫得很完整",
  "可以參考",
];

/**
 * 婉拒句不算落地率。
 *
 * 「這超出我能代為回答的範圍」這種句子本來就不會出現在語料裡，落地率必然趨近 0——
 * 但它正是我們**希望**她說的話。不跳過的話，護欄會專門攔下守規矩的回答，
 * 把一個正確的婉拒換成另一句罐頭婉拒，看起來像壞掉。
 *
 * ⚠️ 要比對在剝固定用語**之前**的字串：「沒有記載」同時也在 BOILERPLATE 裡，
 * 剝完就找不到了。
 */
const DECLINE_MARKERS = ["沒有記載", "答不上來", "不方便表態", "超出我能代為回答"];

/** 只留中日韓統一表意文字。標點、數字、英數、markdown 殘渣一律不進比對 */
function cjkOnly(text: string): string {
  return (text.match(/[一-鿿]/g) ?? []).join("");
}

/**
 * 語料裡出現過的所有《》〈〉標題，由 `npm run build:titles` 產生。
 *
 * 🔴 為什麼要有這一份：原本引用檢查只放行 OWN_BOOKS（她自己那兩本書），
 * 窄到會攔下網站自己的罐頭句——`OUT_OF_SCOPE_REPLY` 裡的《婦女新知》
 * 被判成「未落地引用」，而那是**她創辦的雜誌**。
 * 語料裡這樣的標題有 196 種（婦女新知 17 次、眾女成城 15、民法．親屬編 13、
 * 女人詩眼 12…），她引用它們是正常的，不是編造。
 *
 * 正確的判準是「**整個語料庫裡都沒有的標題**才是預訓練編出來的」——
 * 〈狼來了〉在語料裡是 0 次，所以它仍然會被攔；《婦女新知》不會。
 *
 * ⚠️ 存成 Set 並且先過 cjkOnly：citations() 回傳的 title 也是濾過標點的形式，
 * 兩邊不同步的話「民法．親屬編」永遠對不上「民法親屬編」。
 * ⚠️ 用完全比對不用 startsWith：這一支是高精度檢查，寧可放窄。
 * 放寬的責任交給另外兩個來源（context 與 OWN_BOOKS）。
 */
const KNOWN_TITLE_SET = new Set(
  KNOWN_TITLES.map((t) => cjkOnly(t)).filter((t) => t.length > 0)
);

function stripBoilerplate(cjk: string): string {
  let out = cjk;
  for (const phrase of BOILERPLATE) out = out.split(phrase).join("");
  return out;
}

/** 《…》與〈…〉裡的標題。回傳含括號的原樣（給錯誤訊息）與純中文形（給比對） */
function citations(text: string): { raw: string; title: string }[] {
  const found: { raw: string; title: string }[] = [];
  // ⚠️ 用 exec 迴圈而不是 matchAll：tsconfig 沒設 target，matchAll 的迭代過不了 tsc
  const re = /《([^》\n]{0,60})》|〈([^〉\n]{0,60})〉/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const title = cjkOnly(m[1] ?? m[2] ?? "");
    if (title) found.push({ raw: m[0], title });
  }
  return found;
}

/**
 * 落地檢查。兩個子檢查，任一命中就視同封鎖。
 *
 * a. **引用落地**（高精度）：答案裡的《…》〈…〉必須在 context、語料標題清單
 *    或她自己的書裡找得到。編造最外顯的形式就是講出一篇沒人給過她的文章篇名。
 * b. **落地率**（高召回）：整段答案的 3-gram 有多少比例在 context 裡有影子。
 *
 * ⚠️ 引用落地刻意**沒有**「chunks 為空就跳過」這條。
 * 沒有任何參考資料卻能講出篇名，那定義上就是編的。
 * （實務上到不了這裡：route 在 inScope=false 時就直接婉拒了。）
 */
export function groundingCheck(text: string, context: GuardContext): GroundingVerdict {
  const contextCjk = cjkOnly(
    [context.question, ...context.chunks.flatMap((c) => [c.title, c.content])].join("\n")
  );

  // 三個放行來源，缺一不可——各自擋掉的是不同的東西：
  //   context      這次真的檢索到的塊（含訪客自己在問句裡講出的篇名）。
  //                少了它，模型照著眼前資料引用反而被攔。
  //   KNOWN_TITLES 語料裡出現過但這次沒檢索到的標題（《婦女新知》《民法．親屬編》…）。
  //                少了它，罐頭句與她講了幾十年的法條都會被誤判成編造。
  //   OWN_BOOKS    她自己的書。prompt 規則 9 主動要求她把人帶到書上，
  //                而《我來了》這個簡稱在語料標題裡找不到（語料寫的是全名）。
  //                少了它，等於在罰她照規則做事。
  for (const cite of citations(text)) {
    if (OWN_BOOKS.some((b) => cite.title.startsWith(b))) continue;
    if (contextCjk.includes(cite.title)) continue;
    if (KNOWN_TITLE_SET.has(cite.title)) continue;
    return { blocked: true, reason: `未落地引用：${cite.raw}`, rate: null };
  }

  const answerCjk = cjkOnly(text);

  // 跳過條件。每一條都要有理由，見上面各常數的註解。
  if (context.chunks.length === 0) {
    // 沒有檢索到任何東西，落地率對誰都是 0，算了也只是一律封鎖
    return { blocked: false, rate: null, skipped: "沒有檢索到參考資料" };
  }
  if (DECLINE_MARKERS.some((m) => answerCjk.includes(m))) {
    return { blocked: false, rate: null, skipped: "婉拒句" };
  }

  const core = stripBoilerplate(answerCjk);
  if (core.length < MIN_CHARS) {
    return { blocked: false, rate: null, skipped: `剝掉固定用語後只剩 ${core.length} 字` };
  }

  let hit = 0;
  const total = core.length - NGRAM + 1;
  for (let i = 0; i < total; i += 1) {
    if (contextCjk.includes(core.slice(i, i + NGRAM))) hit += 1;
  }
  const rate = hit / total;

  if (rate < GROUNDING_FLOOR) {
    return { blocked: true, reason: `落地率 ${Math.round(rate * 100)}%`, rate };
  }
  return { blocked: false, rate };
}

/**
 * 🔴 60 → 140 是為了讓落地檢查來得及。
 *
 * 落地檢查要拿**整段**答案才算得出來，所以只能放在 finish()。但字一旦 emit 出去
 * 就收不回來（見 lib/avatar/types.ts 的 speakableAnswer：那是這個專案的老坑）。
 * lib/persona-prompt.ts 規則 8 把回答上限定在 100 字，緩衝 ≥ 140 等於
 * 「整段看完再吐出」，finish() 的檢查實質上變成吐出前檢查。
 *
 * 取捨：
 * - 數位人（/live 系列）本來就在串流結束後才用
 *   `finish(speakableAnswer(full, GUARDED_REPLY))` 開口，時機完全不變。
 *   逐句朗讀的 monogram driver 反而變安全了——它現在也是整段才收到。
 * - /chat 文字版會從「逐字出現」變成「約 100 字一次出現」，延遲等於生成時間
 *   （1–2 秒）。這是知情的取捨：用打字機效果換一層守門。
 *
 * ⚠️ 殘餘風險，不要假裝沒有：100 字是 prompt 上限，不是硬限制，模型偶爾會超過。
 * 超過 140 的部分仍然會先吐出去；此時 finish 攔下的話 /chat 會看到半段＋罐頭句，
 * 數位人端由 speakableAnswer 處理（結尾是 GUARDED_REPLY 就只講 GUARDED_REPLY）。
 */
const BUFFER_CHARS = 140;

/**
 * 滾動緩衝的串流寫入器：先扣住尾端 BUFFER_CHARS 字再吐出，
 * 讓封鎖樣式在跨 delta 邊界時也能被抓到。
 *
 * @param context 這次檢索到的題目與參考資料。**給了才做落地檢查**；
 *   不給的話行為與加入落地檢查之前完全一樣（既有測試就是這條的證據）。
 */
export function createGuardedWriter(
  emit: (text: string) => void,
  onBlocked: (matched: string) => void,
  context?: GuardContext
) {
  let pending = "";
  let full = "";
  let blocked = false;

  return {
    push(delta: string) {
      if (blocked) return;
      pending += delta;
      full += delta;

      const check = checkAnswer(full);
      if (check.blocked) {
        blocked = true;
        onBlocked(check.matched ?? "unknown");
        return;
      }

      if (pending.length > BUFFER_CHARS) {
        const flushable = pending.slice(0, pending.length - BUFFER_CHARS);
        pending = pending.slice(pending.length - BUFFER_CHARS);
        emit(stripMarkdown(flushable));
      }
    },
    finish(): { text: string; blocked: boolean } {
      if (blocked) return { text: full, blocked: true };

      if (context) {
        const verdict = groundingCheck(full, context);
        if (verdict.blocked) {
          blocked = true;
          // 🔴 一定要在 emit 之前丟掉 pending。整段答案都還扣在緩衝裡，
          // 這一行就是「有出處才放行」真正生效的地方。
          pending = "";
          onBlocked(verdict.reason ?? "未落地");
          return { text: full, blocked: true };
        }
      }

      if (pending) {
        emit(stripMarkdown(pending));
        pending = "";
      }
      return { text: full, blocked: false };
    },
  };
}
