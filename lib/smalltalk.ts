/**
 * 寒暄快速路徑：訪客這一句「只是」招呼、感謝、道別或應答（你好、謝謝、再見、好）。
 *
 * 命中就由 app/api/chat/route.ts 直接回 content/site.ts 的固定文字
 * （SMALLTALK_GREETING_REPLY／SMALLTALK_THANKS_REPLY／SMALLTALK_FAREWELL_REPLY），
 * 不檢索、不呼叫 LLM、不經過護欄。
 *
 * 🔴 為什麼要有：本機完整重跑時，「你食飽未」「哈哈」「妳記得我嗎」這類寒暄常被落地檢查換成
 * 「這一題我答不上來——資料裡找不到可靠的出處」。對公開的數位人，這是最常見也最難看的失誤：
 * 寒暄本來就沒有東西可以落地，交給「只根據語料回答＋落地檢查」那條路只會答得更怪。
 *
 * ## 判準
 *
 * 1. **只比對整句。** 去掉標點、空白、表情與頭尾的語氣詞之後，必須「完全等於」清單上的一個詞。
 *    「你好，請問婦女新知是哪一年成立的」帶著問題，一律走原路徑；「謝謝你」「老師好」
 *    這類要收就加進清單（2026-09-25 已加），不要放寬比對方式。
 * 2. **順序由 route 決定：危機判斷之後、檢索之前。** 上一句是危機回覆時 route 不會叫這支——
 *    危機對話裡的「好」「嗯」要走延續邏輯，回到專線，不能被回一句「不客氣」。
 * 3. **應答語共用 lib/query-expansion.ts 的 GREETINGS**（好、好的、嗯、哦、喔、了解、知道了），
 *    不另抄一份；那份清單的招呼、感謝、道別也都在下面三類裡。
 * 4. **上一句以問句或邀請收尾時，應答不算寒暄**（route 用 modelInvites() 判斷）：模型剛問
 *    「想聽聽我創辦婦女新知的經過嗎？」，訪客的「好啊」是要她繼續。招呼、感謝、道別不受影響。
 * 5. **讚美（第十輪）也只比對整句**：每一個子句都要是讚美的話（「妳好厲害喔 我好崇拜妳」「妳是我的偶像」
 *    「謝謝妳為女性做的一切」「老師辛苦了」），旁邊只容許招呼、感謝、應答、道別這幾種子句。
 *    帶著問題的（「妳覺得妳做過最厲害的事是什麼」「妳最崇拜誰」「妳的偶像是誰」）一律走原路徑。
 */
import { GREETINGS } from "./query-expansion";
import { toTraditional } from "./crisis";
import {
  CRISIS_SELF_HARM_REPLY,
  CRISIS_VIOLENCE_REPLY,
  FALLBACK_REPLY,
  GUARDED_REPLY,
  OUT_OF_SCOPE_REPLY,
  PRIVACY_REPLY,
  REFUSAL_CREATION_REPLY,
  REFUSAL_ERRAND_REPLY,
  REFUSAL_FINANCE_REPLY,
  REFUSAL_HARASSMENT_REPLY,
  REFUSAL_MEDICAL_REPLY,
  REFUSAL_PRIVACY_REPLY,
  REFUSAL_PROFANITY_REPLY,
  SMALLTALK_FAREWELL_REPLY,
  SMALLTALK_GREETING_REPLY,
  SMALLTALK_PRAISE_REPLY,
  SMALLTALK_THANKS_REPLY,
  UNGROUNDED_REPLY,
  VENTING_REPLY,
} from "../content/site";

/** thanks 與 ack 共用同一句回覆（見 content/site.ts），分開只是為了測試與紀錄看得懂。 */
export type SmalltalkKind = "greeting" | "thanks" | "farewell" | "ack" | "praise";

/** 招呼。「哈哈」照需求清單的順序歸在招呼（清單把它排在哈囉後面）。 */
const GREETING = new Set([
  "你好", "妳好", "您好", "嗨", "哈囉", "哈哈", "在嗎", "早安", "午安", "晚安", "你食飽未", "食飽未",
  // 2026-09-25 補：展場與學生最常見的開場白。「你好嗎」問的是近況，但招呼那句只介紹 AI 分身、
  // 不談老師本人的近況，回它是安全的；交給模型反而可能被落地檢查換成「找不到出處」。
  "老師好", "李老師好", "你好嗎", "妳好嗎", "老師你好", "老師妳好",
]);
const THANKS = new Set(["謝謝", "感謝", "謝啦", "謝謝你", "謝謝妳", "謝謝您", "謝謝老師", "感謝老師"]);
const FAREWELL = new Set(["再見", "掰掰", "拜拜"]);

function classify(word: string): SmalltalkKind | null {
  if (GREETING.has(word)) return "greeting";
  if (THANKS.has(word)) return "thanks";
  if (FAREWELL.has(word)) return "farewell";
  // GREETINGS 裡其餘的就是應答語
  if (GREETINGS.has(word)) return "ack";
  return null;
}

/** 文字與數字以外的一切：標點、空白、表情。（建構子：tsconfig 沒設 target，字面值的 u 旗標會被 tsc 擋。） */
const NOT_TEXT = new RegExp("[^\\p{L}\\p{N}]+", "gu");

/**
 * 頭尾可以去掉的語氣詞，一次去一個，每去一次就重新比對一次——所以「喔」「哦」本身
 * 還是認得出來，「謝啦」也不會被去成「謝」。
 * ⚠️ 不收「嗎」：「你好嗎」「好嗎」是問句。不收「的」「哈」：「好的」「哈哈」本身就在清單上。
 */
const LEADING_PARTICLE = /^[啊喔哦嗯欸耶哇嘿]/;
const TRAILING_PARTICLE = /[啊呀啦喔哦囉耶欸唷呦嘿嘛吧呢哇咧捏餒了]$/;

/**
 * 對她的稱呼。「謝謝老師」「早安老師」「謝謝妳」去掉稱呼之後就是清單上的詞；
 * 「老師好」「李老師好」單獨認成招呼（去掉稱呼會剩下應答的「好」）。
 * ⚠️ 只去頭尾、而且只在剩下的字就是清單上的詞時才算——「老師 妳小時候…」不會因為去掉稱呼就變寒暄。
 */
const ADDRESS = "(?:李元貞老師|元貞老師|李老師|數位李元貞|老師|元貞)";
const ADDRESS_LEADING = new RegExp(`^${ADDRESS}`);
const ADDRESS_TRAILING = new RegExp(`(?:${ADDRESS}|你們?|妳們?|您)$`);
const ADDRESS_HELLO = new RegExp(`^${ADDRESS}好$`);

/**
 * 這一句是不是整句的寒暄。是的話回類別，不是回 null。
 * 重複的字先收斂：「哈哈哈哈」→ 哈哈、「嗯嗯」→ 嗯、「好好好」→ 好（「掰掰」「拜拜」「謝謝」本來就是疊字，不收斂）。
 * 然後一次去掉一個頭尾的稱呼或語氣詞，每去一次就重新比對一次。
 */
export function detectSmalltalk(message: string): SmalltalkKind | null {
  return wholeWord(toTraditional(message).replace(NOT_TEXT, "")) ?? detectPraise(message);
}

/** 疊字收斂：「哈哈哈哈」→ 哈哈、「嗯嗯」→ 嗯、「好好好」→ 好 */
function collapse(text: string): string {
  return text.replace(/哈{3,}/g, "哈哈").replace(/([嗯喔哦好嗨])\1+/g, "$1");
}

/** 已經拿掉標點與空白的字串，整個是不是清單上的一個詞（一次去掉一個頭尾的稱呼或語氣詞再比）。 */
function wholeWord(text: string): SmalltalkKind | null {
  let core = collapse(text);
  if (ADDRESS_HELLO.test(core)) return "greeting";
  while (core) {
    const kind = classify(core);
    if (kind) return kind;
    if (Array.from(core).length <= 1) return null;
    const next = peel(core);
    if (next === undefined) return null;
    core = next;
  }
  return null;
}

/** 去掉一個頭尾的稱呼或語氣詞；沒有可去的回 undefined */
function peel(core: string): string | undefined {
  return [ADDRESS_TRAILING, ADDRESS_LEADING, LEADING_PARTICLE, TRAILING_PARTICLE]
    .map((re) => core.replace(re, ""))
    .find((stripped) => stripped !== core);
}

/*
 * ════════ 讚美（第十輪，2026-09-28） ════════
 * 🔴 為什麼要有：「妳好厲害喔 我好崇拜妳」模型答得很得體（「謝謝你的鼓勵…當年的婦運，是許多夥伴一起堅持與努力」），
 * 卻被落地檢查換成「這一題我答不上來」——讚美本來就沒有東西可以落地。回 content/site.ts 的 SMALLTALK_PRAISE_REPLY。
 *
 * 比照寒暄只比對整句：訊息切成子句（標點、空白），每一個子句去掉頭尾的稱呼與語氣詞之後，
 * 都要「整個」是下面其中一種講法（一個子句最多連寫三種，「妳好厲害我好崇拜妳」沒有空白也認得）；
 * 旁邊只容許招呼、感謝、應答、道別這幾種子句（「老師好 妳好厲害」「謝謝老師 辛苦了」）。
 * 🔴 不可以命中（走原路徑，交給模型）：「妳覺得妳做過最厲害的事是什麼」「妳最崇拜誰」「妳的偶像是誰」
 * 「我好喜歡妳的詩」「妳當年很辛苦吧」「妳好漂亮」——帶著問題、講她的作品、或是對外表的評論。
 * ⚠️ 簡體：先過 toTraditional；那張表沒收的字（厲、偉、堅、優、傑、讚、歡、貢、獻、爭、奮、鬥、驕、樣、範）在規則裡兩種寫法都寫。
 */

/** 她（含稱謂）或「妳們」 */
const P_SUBJECT = "(?:數位李元貞|李元貞老師|元貞老師|李老師|李元貞|老師|妳們|你們|妳|你|您)";
/** 程度副詞 */
const P_DEGREE = "(?:真的|真是|實在|非常|超級|超|好|很|真|太|最|也|一直都|一直|永遠都|永遠|都)";
/** 誇她本人的形容詞。⚠️ 不收外表（漂亮、美、帥）：那是對外表的評論，回「婦運是許多人一起走出來的路」答非所問 */
const P_GREAT = "(?:[厲厉]害|棒|勇敢|了不起|[偉伟]大|[堅坚]強|強|[優优]秀|[傑杰]出|有勇氣|有智慧|[讚赞]|酷)";
const P_ADMIRE = "(?:崇拜|佩服|敬佩|欽佩|尊敬|敬仰|景仰|欣賞|喜[歡欢]|支持)";
const P_IDOL = "(?:偶像|榜[樣样]|典[範范]|模[範范]|英雄|[驕骄]傲|楷模)";
/** 謝她為誰做的事 */
const P_FOR_WHOM =
  "(?:我們女生|我們女性|我們|大家|(?:台灣|臺灣)?(?:女性|女人|婦女|女生)|台灣|臺灣|社會|婦運|婦女運動|女權|性別平等|後輩)";
const P_EFFORT = "(?:付出|努力|[貢贡][獻献]|奉[獻献]|堅持|[奮奋][鬥斗])";
const P_SINCE = "(?:一直以來|這些年來?|多年來|這麼多年來?|長期以來)";

const PRAISE_UNITS = [
  // 妳好厲害、好棒、太強了、老師好勇敢、妳真的很了不起
  `${P_SUBJECT}?${P_DEGREE}*${P_GREAT}`,
  // 我好崇拜妳、我很佩服妳、好佩服、我一直很支持妳
  `(?:我${P_DEGREE}*)?${P_DEGREE}*${P_ADMIRE}${P_SUBJECT}?`,
  // 妳是我的偶像、妳是我們的榜樣、妳是台灣女性的驕傲、妳是台灣之光
  `${P_SUBJECT}?${P_DEGREE}*(?:是|就是|真是|真的是|一直是|永遠是)(?:(?:我們?|(?:台灣|臺灣)?(?:女性|女人|婦女|女生)|台灣|臺灣)(?:心中|心目中)?的?${P_IDOL}|(?:台灣|臺灣)之光)`,
  // 我的偶像就是妳、我最崇拜的人就是妳
  `我們?的?${P_IDOL}(?:就)?是${P_SUBJECT}`,
  `我${P_DEGREE}*${P_ADMIRE}的人(?:就)?是${P_SUBJECT}`,
  // 謝謝妳為女性做的一切、感謝老師為台灣婦女所做的一切、謝謝妳為我們爭取的權益、感謝妳為婦運的付出
  `(?:謝謝|感謝|感恩|謝)${P_SUBJECT}?${P_DEGREE}*${P_SINCE}?的?(?:為|替|幫)${P_FOR_WHOM}(?:(?:所)?(?:做|付出|[爭争]取|[奮奋][鬥斗]|努力|打拼|[貢贡][獻献]|奉[獻献]|做出)(?:的|了)?(?:一切|這一切|這麼多|那麼多|努力|付出|[貢贡][獻献]|事情?|權益|權利)?|的${P_EFFORT})`,
  // 謝謝妳的付出、感謝您一直以來的努力、謝謝妳們的努力
  `(?:謝謝|感謝|感恩|謝)${P_SUBJECT}?${P_SINCE}?的?${P_EFFORT}`,
  // 老師辛苦了、辛苦了、妳辛苦了、辛苦妳了。⚠️ 沒有對象又帶程度副詞的「好辛苦」「很辛苦」不算：
  // 那多半是訪客在講自己很累，回「謝謝你。婦運是許多人一起走出來的路」答非所問（第十四輪複審探針抓到）
  `${P_SUBJECT}${P_DEGREE}*辛苦${P_SUBJECT}?|${P_DEGREE}*辛苦${P_SUBJECT}|辛苦`,
  // 向妳致敬、致敬
  `(?:向)?${P_SUBJECT}?(?:致敬|致上(?:最高的)?敬意|敬禮)`,
];
const PRAISE_UNIT = `(?:${PRAISE_UNITS.join("|")})`;
/**
 * 一個子句最多連寫三種講法，中間與結尾可以夾語氣詞（「妳好厲害喔我好崇拜妳」「太厲害了我好崇拜妳」「老師真的辛苦了」）。
 * 結尾的語氣詞要在這裡吃掉：去頭尾稱呼會先把「老師」拿掉，「老師真的辛苦了」就只剩沒有對象的「真的辛苦了」。
 */
const PRAISE_PARTICLES = "[啊呀啦喔哦耶欸唷呦嘿嘛吧呢哇了]*";
const PRAISE_CLAUSE = new RegExp(`^${PRAISE_UNIT}(?:${PRAISE_PARTICLES}${PRAISE_UNIT}){0,2}${PRAISE_PARTICLES}$`);
/** 整句讚美不會很長；超過這個字數多半帶著別的內容，交給原路徑 */
const PRAISE_MAX_CHARS = 40;

/** 這個子句（已拿掉標點）是不是整個都是讚美：一次去掉一個頭尾的稱呼或語氣詞再比 */
function isPraiseClause(clause: string): boolean {
  let core = collapse(clause);
  while (core) {
    if (PRAISE_CLAUSE.test(core)) return true;
    const next = peel(core);
    if (next === undefined) return false;
    core = next;
  }
  return false;
}

/**
 * 整句讚美。至少一個子句是讚美、其餘子句只能是招呼／感謝／應答／道別；有道別時回 farewell
 * （「老師辛苦了 再見」——訪客要走了，回道別那句）。
 */
function detectPraise(message: string): SmalltalkKind | null {
  const clauses = toTraditional(message).split(NOT_TEXT).filter(Boolean);
  if (clauses.length === 0 || Array.from(clauses.join("")).length > PRAISE_MAX_CHARS) return null;
  let praised = false;
  let farewell = false;
  for (const clause of clauses) {
    if (isPraiseClause(clause)) {
      praised = true;
      continue;
    }
    const kind = wholeWord(clause);
    if (!kind) return null;
    if (kind === "farewell") farewell = true;
  }
  if (!praised) return null;
  return farewell ? "farewell" : "praise";
}

/**
 * 模型上一句是不是以問句或邀請收尾：結尾是「？」「嗎」「呢」，或最後一句有「想聽／要不要／想不想／可以問我」。
 * 是的話，訪客的應答（好、好啊、嗯嗯）是要她繼續——route 就不走寒暄路徑，交給原路徑
 * （lib/query-expansion.ts 的 needsContext 會把「好啊」當追問，接上前一題）。
 *
 * 🔴 第三輪驗收：模型剛問「想聽聽我創辦婦女新知的經過嗎？」，訪客回「好啊」，寒暄路徑卻回「不客氣」。
 * ⚠️ 站方寫死的固定回覆一律不算邀請（第十一輪擴大到全部）：寒暄與讚美、危機、私人資訊／髒話／騷擾／醫療／理財／
 * 代勞／代寫的拒絕、隱私攔截、離題／護欄／落地／生成失敗的罐頭句，以及同理備援（2026-09-29）。它們結尾的「都可以問我」
 * 「要不要換個方向試試？」是泛泛的歡迎，後面接「好」「嗯」就只是應答——讓它走原路徑，query-expansion 會把被拒絕的那一題帶回檢索。
 * 「半段＋罐頭句」也算（結尾是那一句就是）。
 */
const INVITATION = /想聽|要不要|想不想|可以(?:再)?問我/;
const FIXED_REPLIES = [
  SMALLTALK_GREETING_REPLY,
  SMALLTALK_THANKS_REPLY,
  SMALLTALK_FAREWELL_REPLY,
  SMALLTALK_PRAISE_REPLY,
  CRISIS_SELF_HARM_REPLY,
  CRISIS_VIOLENCE_REPLY,
  REFUSAL_PRIVACY_REPLY,
  REFUSAL_PROFANITY_REPLY,
  REFUSAL_HARASSMENT_REPLY,
  REFUSAL_MEDICAL_REPLY,
  REFUSAL_FINANCE_REPLY,
  REFUSAL_ERRAND_REPLY,
  REFUSAL_CREATION_REPLY,
  PRIVACY_REPLY,
  OUT_OF_SCOPE_REPLY,
  GUARDED_REPLY,
  UNGROUNDED_REPLY,
  FALLBACK_REPLY,
  VENTING_REPLY,
];

export function modelInvites(modelText: string): boolean {
  const text = modelText.trim();
  if (!text || FIXED_REPLIES.some((reply) => text.endsWith(reply))) return false;
  if (/(?:[？?]|嗎|呢)[。！!～~…」』）)\s]*$/.test(text)) return true;
  const lastSentence = text.split(/[。！!？?\n]/).map((s) => s.trim()).filter(Boolean).pop() ?? "";
  return INVITATION.test(lastSentence);
}
