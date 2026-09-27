/**
 * 查詢擴展：把「那後來呢？」這種**只靠上文才看得懂**的追問，接上前一題當錨點，
 * 變成可以獨立 embedding 的查詢。純字串處理，不多花一次 LLM 呼叫、不增加延遲。
 *
 * 🔴 為什麼判準要這麼窄（2026-09-22 重寫的原因）
 *
 * 舊版的觸發條件是「訊息短於 12 字，或含有 那/這/他/她/它/其/呢 任一字」，
 * 而且錨點只找長度 ≥12 的上一則使用者提問。量測近 14 天 50 題真實提問：
 *   - 26 題（52%）被擴展；抽樣重放那 26 題，擴展後 top chunk 換了章的有 19 題（73%）。
 *   - 「你怎麼看待婚姻」（7 字）被接成「書中聶湖濱如何述說李元貞 你怎麼看待婚姻」：
 *     原句檢索前 8 名全是第 3 章〈進出婚姻〉（0.742）；擴展後前 6 名全是
 *     【他人敘述．聶湖濱】，〈進出婚姻〉掉到第 7 名被切掉，模型只好答「婚姻的看法沒有記載」。
 *   - 「你有幾個兄弟姊妹？」（9 字）被接成「財團法人婦女權益促進發展基金會是誰 你有幾個兄弟姊妹？」：
 *     原句〈兄弟姊妹〉第 1、〈么妹〉第 3；擴展後 top 掉到 0.662、〈么妹〉掉出前 5——
 *     而「七個、加上么妹」這個人數只寫在〈么妹〉那一節。
 *   - 「你確定沒寫？？」的錨點跳過了緊接在前面的「你有幾個兄弟姊妹？」（9 字 <12），
 *     往前抓到不相干的「基金會是誰」。
 * 反過來，真正需要上文的追問（「你確定沒寫？？」「你確定沒記載？？」「那後來呢？」）
 * 確實存在，不能把擴展整個拿掉。
 *
 * 所以改成：只有句子**形式上**明顯是追問（句尾「呢」、極短的接續詞、追問開頭）才擴展；
 * 「你怎麼看待婚姻」「你有幾個兄弟姊妹？」這種短但完整的問題一律原句檢索。
 */

export interface HistoryTurn {
  role: "user" | "model";
  text: string;
}

/**
 * 句尾標點與空白：算字數、看句尾字之前先剝掉，
 * 「那後來呢？」「你確定沒寫？？」才不會被問號干擾。
 */
const TRAILING_PUNCTUATION = /[?？!！。，,、~～\s]+$/;

/**
 * 極短句的字數上限（規則 b）。
 * 3 字以內的「為什麼」「然後」「繼續」「真的嗎」「還有嗎」離開上文根本沒有意義；
 * 但同樣 3 字以內、以 你/妳/我 開頭的句子（「你是誰」）是完整問題，不算。
 */
const SHORT_FOLLOW_UP_MAX_CHARS = 3;

/**
 * 招呼／應答語：整句去標點後等於其中之一就**不是**追問。
 * 訪客問完一題說「謝謝」，若黏上前一題當查詢，會讓她把上一題再答一次。
 * 近 14 天實際出現過「哈囉」；其餘是同類常見寫法。
 * ⚠️ lib/smalltalk.ts 也用這一份（寒暄快速路徑的「應答語」），改這裡兩邊一起變。
 */
export const GREETINGS = new Set([
  "哈囉", "嗨", "你好", "妳好", "您好",
  "謝謝", "感謝", "再見", "掰掰", "拜拜",
  "好", "好的", "嗯", "哦", "喔", "了解", "知道了",
]);

/**
 * 追問句的字數上限（規則 a 與規則 c 共用）。
 * 「你確定沒寫」（5 字）「你確定沒記載」（6 字）「那後來呢」「她後來怎麼了呢」都在 10 字以內；
 * 超過 10 字的句子（「你確定你的書裡沒寫到小孩？那第九章是什麼」「你覺得離婚對女人公平嗎」
 * 「那目前台灣婦女權益的推動還有什麼不足的面向呢」21 字、句尾雖是「呢」）
 * 幾乎都自己帶著主題，接上文只會把主題蓋掉。
 */
const FOLLOW_UP_MAX_CHARS = 10;

/**
 * 追問開頭（規則 c）：可選的「那／你／妳／那你／那妳」，接著是質疑、要求接續或要求展開的詞。
 * 只列真的靠上文才成立的詞。⚠️ 不能放「怎麼看」「有」「對」「最」這種一般問句的開頭——
 * 「你怎麼看待婚姻」「你有幾個兄弟姊妹」「那妳對婚姻妳是什麼看法」「那你最喜歡哪個縣市」
 * 都是能獨立檢索的完整問題，改前全部被誤擴展。
 * ⚠️「不能」「不會」是否定的情態詞，只出現在質疑（「那你不能算一下嗎」「你不會算嗎」）；
 * 「可以」「能不能」是要求（「你可以介紹一下婦女新知嗎」），常帶著完整的內容，不放。
 * 實測「那你不能算一下嗎？」不擴展時原句 0.628 落在第 9 章〈女兒之語〉——在範圍內但完全不相干，
 * 備援機制救不了它（備援只在原句低於門檻時才啟動），只能靠這裡先認出它是追問。
 */
const FOLLOW_UP_HEAD =
  /^(那|你|妳|那你|那妳)?(確定|真的|不會吧|不可能|不能|不會|為什麼|怎麼會|怎麼說|然後|後來|接著|再來|還有|繼續|多說|多講|再說|舉個例|說詳細|說清楚|可以再)/;

/** 句尾語氣詞：算剩餘字數前先剝掉，「你不會算嗎」剩下的才是「算」而不是「算嗎」 */
const TRAILING_PARTICLES = /[嗎呢吧啊呀喔哦了]+$/;

/**
 * 規則 c 的第二道門：命中頭詞之後，剩下的字數上限。
 * 光看開頭不夠——「為什麼？」與「為什麼要創辦婦女新知」開頭一樣，前者剩 0 字是追問，
 * 後者剩 7 字（要創辦婦女新知）自己帶著主題，是完整問題；黏上上一題只會被污染，
 * 而且擴展句通常也在門檻內，備援救不回來。驗收實跑抓到 8 句這種誤判
 * （為什麼要創辦婦女新知、妳還有什麼遺憾嗎、你怎麼說服你先生的、還有哪些女性作家、
 * 你還有寫其他書嗎、後來你去了哪裡、你真的是李元貞嗎、你不能接受什麼）。
 * 3 字涵蓋「沒寫」「沒記載」「算一下」；4 字以上（是李元貞、接受什麼、寫其他書）都是主題。
 */
/**
 * ⚠️ 已知邊界（2026-09-22 驗收實測，刻意不再收緊）：「頭詞＋≤3 字名詞」的極短句仍會被當追問——
 * 為什麼離婚、為什麼寫詩、還有小孩嗎、你還有寫書嗎。這些句子本來就語意曖昧（「還有小孩嗎」
 * 多半真的在追問上一題），而且錨點只會是緊鄰的上一題，代價有限。
 * 要再分就得做詞性判斷，不划算。反方向（11 字的「那你不能再講清楚一點嗎」漏判）是安全的：
 * 退回原句檢索，低於門檻時備援會改用擴展句。
 */
const FOLLOW_UP_REMAINDER_MAX_CHARS = 3;

/**
 * 錨點最多往回看幾個 user turn（含被跳過的追問）。
 * 追問幾乎都緊接在原問題後面，3 個已涵蓋「原問題 → 追問 → 再追問」；
 * 看得更遠正是舊版的病因——跨過好幾題抓到不相干的舊主題。
 */
const MAX_ANCHOR_LOOKBACK = 3;

/** 以字元（code point）計數而非 UTF-16 長度，emoji 才不會被算成兩個字 */
function charCount(text: string): number {
  return Array.from(text).length;
}

/**
 * 規則 c 用：命中 FOLLOW_UP_HEAD 後，去掉前綴與頭詞、再剝句尾語氣詞，回傳剩下的字；
 * 沒命中回 null。「你確定沒寫」→「沒寫」、「那你不能算一下嗎」→「算一下」、「真的嗎」→「」。
 */
function followUpRemainder(core: string): string | null {
  const match = FOLLOW_UP_HEAD.exec(core);
  if (!match) return null;
  return core.slice(match[0].length).replace(TRAILING_PARTICLES, "");
}

/**
 * 這句話是不是離開上文就看不懂的追問。
 * 去掉頭尾空白與句尾標點後，空字串與招呼／應答語（GREETINGS）一律 false；其餘以下任一成立才算：
 *   a. ≤ 10 字、且句尾是「呢」（那後來呢／她後來怎麼了呢／你覺得呢）
 *   b. ≤ 3 字、且不是以 你/妳/我 開頭（為什麼、然後、繼續、真的嗎、還有嗎）
 *   c. ≤ 10 字、符合 FOLLOW_UP_HEAD，且去掉前綴＋頭詞＋句尾語氣詞後剩 ≤ 3 字
 *      （你確定沒寫→「沒寫」✓、那你不能算一下嗎→「算一下」✓、為什麼要創辦婦女新知→「要創辦婦女新知」✗）
 */
export function needsContext(message: string): boolean {
  const core = message.trim().replace(TRAILING_PUNCTUATION, "").trim();
  if (!core) return false;
  if (GREETINGS.has(core)) return false;

  const length = charCount(core);
  if (length <= FOLLOW_UP_MAX_CHARS && core.endsWith("呢")) return true;
  if (length <= SHORT_FOLLOW_UP_MAX_CHARS && !/^[你妳我]/.test(core)) return true;
  if (length <= FOLLOW_UP_MAX_CHARS) {
    const remainder = followUpRemainder(core);
    if (remainder !== null && charCount(remainder) <= FOLLOW_UP_REMAINDER_MAX_CHARS) return true;
  }

  return false;
}

/**
 * 找追問要接的錨點：從最近的 user turn 往回找，最多看 MAX_ANCHOR_LOOKBACK 個 user turn，
 * 跳過本身也是追問（needsContext 為真）或空白的 turn，回傳第一個合格的 turn 文字（trim 後）。
 * 不再有舊版「長度 ≥12」的條件——那正是「你確定沒寫？？」跳過「你有幾個兄弟姊妹？」的原因。
 * 找不到回 null，呼叫端就用原句檢索。
 */
export function findAnchor(history: HistoryTurn[]): string | null {
  let examined = 0;
  for (let i = history.length - 1; i >= 0 && examined < MAX_ANCHOR_LOOKBACK; i--) {
    const turn = history[i];
    if (turn.role !== "user") continue;
    examined++;
    const text = turn.text.trim();
    if (!text || needsContext(text)) continue;
    return text;
  }
  return null;
}

/**
 * 把錨點接在原句前面，組成擴展句。組法只有這一份：
 * expandQuery 與 lib/retrieval/index.ts 的備援查詢都從這裡拿，不各自拼字串。
 */
export function withAnchor(message: string, anchor: string): string {
  return `${anchor} ${message}`;
}

/**
 * needsContext 為假 → 原句；為真且找得到錨點 → withAnchor(原句, 錨點)；否則原句。
 */
export function expandQuery(message: string, history: HistoryTurn[] = []): string {
  const current = message.trim();
  if (!current) return current;
  if (!needsContext(current)) return current;

  const anchor = findAnchor(history);
  if (!anchor) return current;
  return withAnchor(current, anchor);
}
