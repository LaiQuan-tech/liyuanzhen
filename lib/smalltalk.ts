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
 */
import { GREETINGS } from "./query-expansion";
import { toTraditional } from "./crisis";
import {
  SMALLTALK_FAREWELL_REPLY,
  SMALLTALK_GREETING_REPLY,
  SMALLTALK_THANKS_REPLY,
} from "../content/site";

/** thanks 與 ack 共用同一句回覆（見 content/site.ts），分開只是為了測試與紀錄看得懂。 */
export type SmalltalkKind = "greeting" | "thanks" | "farewell" | "ack";

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
  let core = toTraditional(message)
    .replace(NOT_TEXT, "")
    .replace(/哈{3,}/g, "哈哈")
    .replace(/([嗯喔哦好嗨])\1+/g, "$1");
  if (ADDRESS_HELLO.test(core)) return "greeting";
  while (core) {
    const kind = classify(core);
    if (kind) return kind;
    if (Array.from(core).length <= 1) return null;
    const next = [ADDRESS_TRAILING, ADDRESS_LEADING, LEADING_PARTICLE, TRAILING_PARTICLE]
      .map((re) => core.replace(re, ""))
      .find((stripped) => stripped !== core);
    if (next === undefined) return null;
    core = next;
  }
  return null;
}

/**
 * 模型上一句是不是以問句或邀請收尾：結尾是「？」「嗎」「呢」，或最後一句有「想聽／要不要／想不想／可以問我」。
 * 是的話，訪客的應答（好、好啊、嗯嗯）是要她繼續——route 就不走寒暄路徑，交給原路徑
 * （lib/query-expansion.ts 的 needsContext 會把「好啊」當追問，接上前一題）。
 *
 * 🔴 第三輪驗收：模型剛問「想聽聽我創辦婦女新知的經過嗎？」，訪客回「好啊」，寒暄路徑卻回「不客氣」。
 * ⚠️ 站方自己的三句寒暄回覆不算邀請：「不客氣，還想知道什麼都可以再問我。」的「可以再問我」是泛泛的歡迎，
 * 後面接「好」「嗯」就只是應答；讓它走原路徑，只會拿到離題罐頭。
 */
const INVITATION = /想聽|要不要|想不想|可以(?:再)?問我/;
const OWN_REPLIES = new Set([SMALLTALK_GREETING_REPLY, SMALLTALK_THANKS_REPLY, SMALLTALK_FAREWELL_REPLY]);

export function modelInvites(modelText: string): boolean {
  const text = modelText.trim();
  if (!text || OWN_REPLIES.has(text)) return false;
  if (/(?:[？?]|嗎|呢)[。！!～~…」』）)\s]*$/.test(text)) return true;
  const lastSentence = text.split(/[。！!？?\n]/).map((s) => s.trim()).filter(Boolean).pop() ?? "";
  return INVITATION.test(lastSentence);
}
