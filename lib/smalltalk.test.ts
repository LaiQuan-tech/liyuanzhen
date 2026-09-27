import { describe, it, expect } from "vitest";
import { detectSmalltalk, modelInvites } from "./smalltalk";
import { GREETINGS } from "./query-expansion";
import {
  GUARDED_REPLY,
  SMALLTALK_FAREWELL_REPLY,
  SMALLTALK_GREETING_REPLY,
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
    GUARDED_REPLY, // 「要不要換個方向試試？」
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
  ])("不是邀請：%j", (text) => {
    expect(modelInvites(text)).toBe(false);
  });
});
