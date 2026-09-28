import { describe, it, expect } from "vitest";
import { detectSmalltalk, modelInvites } from "./smalltalk";
import { GREETINGS } from "./query-expansion";
import * as site from "@/content/site";
import {
  GUARDED_REPLY,
  SMALLTALK_FAREWELL_REPLY,
  SMALLTALK_GREETING_REPLY,
  SMALLTALK_PRAISE_REPLY,
  SMALLTALK_THANKS_REPLY,
} from "@/content/site";

/**
 * 寒暄快速路徑的規格。清單照需求逐項列：每一項都要命中正確的類別，
 * 帶著問題的句子一律不命中（交給原路徑）。危機延續優先的部分在 app/api/chat/route.test.ts。
 */
const LIST: Array<[string, "greeting" | "thanks" | "farewell" | "ack"]> = [
  ["你好", "greeting"],
  ["妳好", "greeting"],
  ["您好", "greeting"],
  ["嗨", "greeting"],
  ["哈囉", "greeting"],
  ["哈哈", "greeting"],
  ["在嗎", "greeting"],
  ["早安", "greeting"],
  ["午安", "greeting"],
  ["晚安", "greeting"],
  ["你食飽未", "greeting"],
  ["食飽未", "greeting"],
  ["謝謝", "thanks"],
  ["感謝", "thanks"],
  ["謝啦", "thanks"],
  ["再見", "farewell"],
  ["掰掰", "farewell"],
  ["拜拜", "farewell"],
  ["好", "ack"],
  ["好的", "ack"],
  ["嗯", "ack"],
  ["喔", "ack"],
  ["哦", "ack"],
  ["了解", "ack"],
  ["知道了", "ack"],
];

/** 標點、空白、表情、頭尾語氣詞、疊字、簡體——去掉之後仍是清單上的詞 */
const VARIANTS: Array<[string, "greeting" | "thanks" | "farewell" | "ack"]> = [
  ["你好！", "greeting"],
  ["  哈囉～ ", "greeting"],
  ["你好啊", "greeting"],
  ["哈哈哈哈", "greeting"],
  ["你食飽未？", "greeting"],
  ["晚安囉", "greeting"],
  ["謝謝啦", "thanks"],
  ["謝謝🙏", "thanks"],
  ["掰掰～", "farewell"],
  ["好喔", "ack"],
  ["嗯嗯", "ack"],
  ["好好好", "ack"],
  ["了解了", "ack"],
  ["谢谢", "thanks"], // 簡體
  ["再见", "farewell"],
  // 2026-09-25 補進清單的開場白與感謝
  ["老師好", "greeting"],
  ["李老師好！", "greeting"],
  ["你好嗎？", "greeting"],
  ["謝謝你", "thanks"],
  ["謝謝老師～", "thanks"],
  // 對她的稱呼放在頭尾：去掉之後就是清單上的詞（第三輪驗收的探測句）
  ["謝謝老師！", "thanks"],
  ["谢谢你", "thanks"], // 簡體
  ["早安老師", "greeting"],
  ["老師再見", "farewell"],
  ["老師好😊", "greeting"],
];

/** 帶著問題或清單以外的內容——走原路徑，不可以回罐頭寒暄 */
const NOT_SMALLTALK = [
  "你好，請問婦女新知是哪一年成立的",
  "哈囉 妳是誰",
  "謝謝 那妳後來呢",
  "好 那華西街那場遊行呢",
  "妳記得我嗎",
  "好嗎", // 問句：「嗎」刻意不當語氣詞去掉（「你好嗎」是整句收進清單，不是靠去掉「嗎」）
  "你好嗎 妳身體還好嗎", // 帶著近況的問題，走原路徑
  "晚安，我睡不著",
  "謝謝，那妳後來為什麼離婚",
  "再見了這個世界", // 這是危機（lib/crisis.ts 先攔），不是道別
  "老師 妳小時候被打的事是真的嗎", // 去掉稱呼也不是清單上的詞
  "哈",
  "老師",
  "",
  "？？？",
];

/**
 * 🔴 第十輪：讚美。「妳好厲害喔 我好崇拜妳」模型答得很得體，卻被落地檢查換成「這一題我答不上來」。
 * 比照寒暄只比對整句：每一個子句都要是讚美的話，旁邊只容許招呼、感謝、應答、道別。前五句是需求原句。
 */
const PRAISE = [
  "妳好厲害喔 我好崇拜妳", // X-08
  "妳好棒",
  "妳是我的偶像",
  "謝謝妳為女性做的一切",
  "老師辛苦了",
  // 變形
  "妳好厲害喔我好崇拜妳", // 沒有空白也認得（一個子句最多連寫三種）
  "太厲害了！",
  "妳真的很了不起",
  "我很佩服妳",
  "好佩服",
  "向妳致敬",
  "謝謝老師為台灣婦女所做的一切",
  "感謝您一直以來的努力",
  "妳是台灣之光",
  "妳是台灣女性的驕傲",
  "我最崇拜的人就是妳",
  "李老師妳好勇敢",
  "辛苦妳了",
  "妳們辛苦了",
  "老師好 妳好厲害", // 招呼＋讚美
  "謝謝老師 辛苦了", // 感謝＋讚美
  "老師真的辛苦了",
  "真是辛苦妳了",
  "妳好棒👍",
  "你好厉害", // 簡體
  "谢谢你为女性做的一切", // 簡體
];

/** 🔴 帶著問題、講她的作品、評論外表、講別人——走原路徑。前三句是需求列的反例 */
const NOT_PRAISE = [
  "妳覺得妳做過最厲害的事是什麼",
  "妳最崇拜誰",
  "妳的偶像是誰",
  "妳好厲害 妳是怎麼做到的",
  "妳好棒嗎",
  "我好崇拜妳 可以跟我說妳的故事嗎",
  "我好喜歡妳的詩",
  "妳當年很辛苦吧",
  "妳辛苦嗎",
  "妳好漂亮", // 外表不收：回「婦運是許多人一起走出來的路」答非所問
  "他好厲害",
  "呂秀蓮好厲害",
  "婦女新知好厲害",
  "誰是台灣之光",
  "妳覺得誰最厲害",
  "謝謝妳為女性做的一切 但我覺得婦運太激進了",
  "妳是台灣人嗎",
  // 第十四輪：沒有對象的「好辛苦」「很辛苦」多半是訪客在講自己
  "好辛苦",
  "很辛苦喔",
  "最近真的好辛苦",
  "，很辛苦。",
];

describe("detectSmalltalk：讚美", () => {
  it.each(PRAISE)("praise：%s", (q) => {
    expect(detectSmalltalk(q)).toBe("praise");
  });

  it.each(NOT_PRAISE)("不是整句讚美：%s", (q) => {
    expect(detectSmalltalk(q)).toBeNull();
  });

  it("讚美＋道別 → 道別（訪客要走了）", () => {
    expect(detectSmalltalk("老師辛苦了 再見")).toBe("farewell");
  });

  it("單獨的招呼、感謝照舊是寒暄，不是讚美", () => {
    expect(detectSmalltalk("謝謝老師")).toBe("thanks");
    expect(detectSmalltalk("老師好")).toBe("greeting");
    expect(detectSmalltalk("謝謝 再見")).toBeNull(); // 沒有讚美的多子句照舊不收
  });
});

describe("detectSmalltalk", () => {
  it.each(LIST)("清單：%s → %s", (q, kind) => {
    expect(detectSmalltalk(q)).toBe(kind);
  });

  it.each(VARIANTS)("去掉標點與語氣詞：%j → %s", (q, kind) => {
    expect(detectSmalltalk(q)).toBe(kind);
  });

  it.each(NOT_SMALLTALK)("不是整句寒暄：%j", (q) => {
    expect(detectSmalltalk(q)).toBeNull();
  });

  /** 跟 lib/query-expansion.ts 共用同一份 GREETINGS：那份裡的每一個詞這裡都要認得 */
  it("query-expansion 的 GREETINGS 每一個都認得", () => {
    for (const word of Array.from(GREETINGS)) {
      expect(detectSmalltalk(word), word).not.toBeNull();
    }
  });
});

/**
 * 🔴 第三輪驗收：模型剛問「想聽聽我創辦婦女新知的經過嗎？」，訪客回「好啊」，寒暄路徑卻回「不客氣」。
 * 上一句以問句或邀請收尾時，應答不走寒暄（route 用這支判斷）。
 */
describe("modelInvites", () => {
  it.each([
    "那一年我們辦了《婦女新知》。想聽聽我創辦婦女新知的經過嗎？",
    "這段故事很長，你想知道後來的事嗎",
    "華西街那場遊行也很精彩，要不要聽聽看。",
    "我在淡江教了很多年。有興趣的話都可以問我。",
  ])("以問句或邀請收尾：%s", (text) => {
    expect(modelInvites(text)).toBe(true);
  });

  it.each([
    "我在 1982 年和朋友一起辦了《婦女新知》。",
    "在《我來了！》書裡寫得更完整。",
    "",
    // 站方自己的寒暄回覆：「可以再問我」是泛泛的歡迎，後面的「好」「嗯」只是應答
    SMALLTALK_GREETING_REPLY,
    SMALLTALK_THANKS_REPLY,
    SMALLTALK_FAREWELL_REPLY,
    SMALLTALK_PRAISE_REPLY,
  ])("不是邀請：%j", (text) => {
    expect(modelInvites(text)).toBe(false);
  });

  /**
   * 🔴 第十一輪：站方寫死的固定回覆一律不算邀請——拒絕之後的「好」只是應答，
   * 不可以讓 query-expansion 把被拒絕的那一題帶回檢索。GUARDED_REPLY 的「要不要換個方向試試？」也一樣。
   * 用 content/site.ts 的每一個 *_REPLY 自動列舉：之後新增的固定回覆沒加進清單，這裡就會紅。
   */
  const FIXED: Array<[string, string]> = Object.entries(site).flatMap(([name, value]) =>
    name.endsWith("_REPLY") && typeof value === "string" ? [[name, value] as [string, string]] : []
  );
  it("content/site.ts 的固定回覆至少有 18 句（清單沒有被意外截短）", () => {
    expect(FIXED.length).toBeGreaterThanOrEqual(18);
  });
  it.each(FIXED)("站方固定回覆不是邀請：%s", (_name, reply) => {
    expect(modelInvites(reply)).toBe(false);
    // 半段＋固定回覆（護欄攔下、生成失敗時接在已送出的半段後面）也一樣
    expect(modelInvites(`那時候我們幾個朋友湊錢辦雜誌，想聽聽嗎？${reply}`)).toBe(false);
  });

  it("GUARDED_REPLY 以問句收尾，但它是罐頭句，不是邀請", () => {
    expect(GUARDED_REPLY.trim().endsWith("？")).toBe(true);
    expect(modelInvites(GUARDED_REPLY)).toBe(false);
  });
});
