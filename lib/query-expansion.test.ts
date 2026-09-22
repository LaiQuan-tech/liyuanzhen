import { describe, it, expect } from "vitest";
import { expandQuery, findAnchor, needsContext, withAnchor, type HistoryTurn } from "./query-expansion";

/**
 * 可以獨立檢索的完整問題——改前（「<12 字或含 那/這/他/她/它/其/呢」）全部被誤擴展，
 * 其中「你怎麼看待婚姻」「你有幾個兄弟姊妹？」被接上不相干的上一題後 top chunk 換了章。
 */
const STANDALONE = [
  "你怎麼看待婚姻",
  "你怎麼看待做母親這件事",
  "你覺得離婚對女人公平嗎",
  "你有幾個兄弟姊妹？",
  "那你前夫是誰",
  "那你最喜歡哪個縣市？",
  "你有小孩嗎",
  "這本書一共分成幾個章節",
  "那妳對婚姻妳是什麼看法？",
  "你今年幾歲？",
  "第九章是什麼",
  "你確定你的書裡沒寫到小孩？那第九章是什麼",
  "那目前台灣婦女權益的推動還有什麼不足的面向呢", // 21 字，句尾「呢」但是完整問句
  // 以下 8 句開頭像追問（為什麼／還有／後來／真的／不能／怎麼說）但自己帶著主題，靠剩餘字數擋
  "為什麼要創辦婦女新知",
  "妳還有什麼遺憾嗎？",
  "你怎麼說服你先生的",
  "還有哪些女性作家？",
  "你還有寫其他書嗎",
  "後來你去了哪裡？",
  "你真的是李元貞嗎",
  "你不能接受什麼？",
];

/** 離開上文就看不懂的追問——真實對話裡出現過，不能把擴展整個拿掉 */
const FOLLOW_UPS = [
  "你確定沒寫？？",
  "你確定沒記載？？",
  "那後來呢？",
  "然後呢",
  "為什麼？",
  "真的嗎",
  "還有嗎",
  "繼續",
  "你覺得呢",
  "她後來怎麼了呢",
  "那你不能算一下嗎？", // 原句 0.628 會落在第 9 章，不擴展就答非所問
  "你不會算嗎",
];

/** 招呼／應答語：訪客問完一題說「謝謝」，不能黏上前一題再答一次 */
const GREETINGS = [
  "哈囉", "嗨", "你好", "妳好", "您好",
  "謝謝", "感謝", "再見", "掰掰", "拜拜",
  "好", "好的", "嗯", "哦", "喔", "了解", "知道了",
];

describe("needsContext", () => {
  it.each(STANDALONE)("完整問題不擴展：%s", (q) => {
    expect(needsContext(q)).toBe(false);
  });

  it.each(FOLLOW_UPS)("追問要擴展：%s", (q) => {
    expect(needsContext(q)).toBe(true);
  });

  it("空字串與純標點回 false", () => {
    expect(needsContext("")).toBe(false);
    expect(needsContext("   ")).toBe(false);
    expect(needsContext("？？")).toBe(false);
  });

  it("句尾標點與空白不影響判斷", () => {
    expect(needsContext("  那後來呢？！ ")).toBe(true);
    expect(needsContext("你確定沒寫。")).toBe(true);
    expect(needsContext("你怎麼看待婚姻？？")).toBe(false);
  });

  it("規則 a：句尾「呢」也要 ≤10 字才算追問", () => {
    expect(needsContext("那後來呢")).toBe(true);
    expect(needsContext("你覺得呢")).toBe(true);
    expect(needsContext("她後來怎麼了呢")).toBe(true);
    expect(needsContext("那目前台灣婦女權益的推動還有什麼不足的面向呢")).toBe(false);
    expect(needsContext("你對目前台灣婦女權益的推動滿意呢")).toBe(false); // 15 字
  });

  it("規則 b：3 字以內但以 你/妳/我 開頭的是完整問題", () => {
    expect(needsContext("你是誰")).toBe(false);
    expect(needsContext("妳是誰？")).toBe(false);
    expect(needsContext("我是誰")).toBe(false);
  });

  it.each(GREETINGS)("規則 b：招呼／應答語不是追問：%s", (g) => {
    expect(needsContext(g)).toBe(false);
    expect(needsContext(`${g}！`)).toBe(false);
    expect(needsContext(`${g}。`)).toBe(false);
  });

  it("規則 b：不在清單裡的極短句仍是追問", () => {
    expect(needsContext("然後")).toBe(true);
    expect(needsContext("繼續")).toBe(true);
    expect(needsContext("真的嗎")).toBe(true);
    expect(needsContext("好嗎")).toBe(true); // 「好」在清單，「好嗎」不在
  });

  it("規則 c：追問開頭超過 10 字就當作自己帶了主題", () => {
    expect(needsContext("你確定沒寫")).toBe(true);
    expect(needsContext("你確定你的書裡沒寫到兄弟姊妹的人數")).toBe(false);
  });

  it("規則 c：命中頭詞後，去掉前綴、頭詞與句尾語氣詞，剩 ≤3 字才是追問", () => {
    // 剩 0-3 字 → 追問
    expect(needsContext("你確定沒寫")).toBe(true); // 沒寫
    expect(needsContext("你確定沒記載")).toBe(true); // 沒記載
    expect(needsContext("那你不能算一下嗎")).toBe(true); // 算一下
    expect(needsContext("你不會算嗎")).toBe(true); // 算
    expect(needsContext("真的嗎")).toBe(true); // （空）
    expect(needsContext("你確定？")).toBe(true); // （空）
    // 剩 4 字以上 → 自己帶著主題的完整問題
    expect(needsContext("為什麼要創辦婦女新知")).toBe(false); // 要創辦婦女新知
    expect(needsContext("你真的是李元貞嗎")).toBe(false); // 是李元貞
    expect(needsContext("你不能接受什麼")).toBe(false); // 接受什麼
    expect(needsContext("你還有寫其他書嗎")).toBe(false); // 寫其他書
  });
});

describe("findAnchor", () => {
  it("回傳最近一則 user turn 的文字（trim 後），不再要求 ≥12 字", () => {
    const history: HistoryTurn[] = [
      { role: "user", text: "  你有幾個兄弟姊妹？  " },
      { role: "model", text: "（回答）" },
    ];
    expect(findAnchor(history)).toBe("你有幾個兄弟姊妹？");
  });

  it("跳過本身是追問（needsContext 為真）的 turn", () => {
    const history: HistoryTurn[] = [
      { role: "user", text: "財團法人婦女權益促進發展基金會是誰" },
      { role: "model", text: "（回答）" },
      { role: "user", text: "你有幾個兄弟姊妹？" },
      { role: "model", text: "（回答）" },
      { role: "user", text: "你確定沒寫？？" },
      { role: "model", text: "（回答）" },
    ];
    // 「你確定沒寫？？」是追問，要跳過；緊接在前的「你有幾個兄弟姊妹？」才是主題
    expect(findAnchor(history)).toBe("你有幾個兄弟姊妹？");
  });

  it("最多回溯 3 個 user turn：第 3 個之內找得到就回傳", () => {
    const history: HistoryTurn[] = [
      { role: "user", text: "婦女新知基金會是怎麼開始的？" },
      { role: "model", text: "（回答）" },
      { role: "user", text: "然後呢" },
      { role: "model", text: "（回答）" },
      { role: "user", text: "還有嗎" },
      { role: "model", text: "（回答）" },
    ];
    expect(findAnchor(history)).toBe("婦女新知基金會是怎麼開始的？");
  });

  it("最多回溯 3 個 user turn：更早的不看，找不到回 null", () => {
    const history: HistoryTurn[] = [
      { role: "user", text: "婦女新知基金會是怎麼開始的？" },
      { role: "model", text: "（回答）" },
      { role: "user", text: "然後呢" },
      { role: "model", text: "（回答）" },
      { role: "user", text: "還有嗎" },
      { role: "model", text: "（回答）" },
      { role: "user", text: "為什麼？" },
      { role: "model", text: "（回答）" },
    ];
    expect(findAnchor(history)).toBeNull();
  });

  it("只拿 user turn，不拿 model 的回答", () => {
    const onlyModel: HistoryTurn[] = [{ role: "model", text: "這是一段夠長的模型回答內容" }];
    expect(findAnchor(onlyModel)).toBeNull();
  });

  it("空白的 user turn 跳過", () => {
    const history: HistoryTurn[] = [
      { role: "user", text: "李元貞是誰？" },
      { role: "user", text: "   " },
    ];
    expect(findAnchor(history)).toBe("李元貞是誰？");
  });

  it("沒有歷史回 null", () => {
    expect(findAnchor([])).toBeNull();
  });
});

describe("expandQuery", () => {
  const history: HistoryTurn[] = [
    { role: "user", text: "婦女新知基金會是怎麼開始的？" },
    { role: "model", text: "（前一輪的回答）" },
  ];

  it("分支 1：needsContext 為假 → 原句，就算有歷史也不接", () => {
    expect(expandQuery("你怎麼看待婚姻", history)).toBe("你怎麼看待婚姻");
    expect(expandQuery("你有幾個兄弟姊妹？", history)).toBe("你有幾個兄弟姊妹？");
  });

  it("分支 2：needsContext 為真且有錨點 → 「錨點 原句」", () => {
    expect(expandQuery("那後來呢？", history)).toBe("婦女新知基金會是怎麼開始的？ 那後來呢？");
    expect(expandQuery("為什麼？", history)).toBe("婦女新知基金會是怎麼開始的？ 為什麼？");
  });

  it("分支 3：needsContext 為真但沒有錨點 → 原句", () => {
    expect(expandQuery("那後來呢？", [])).toBe("那後來呢？");
    const onlyModel: HistoryTurn[] = [{ role: "model", text: "這是一段夠長的模型回答內容" }];
    expect(expandQuery("那後來呢？", onlyModel)).toBe("那後來呢？");
  });

  it("真實對話：「你確定沒寫？？」接的是緊接在前的「你有幾個兄弟姊妹？」，不是更早的基金會", () => {
    const real: HistoryTurn[] = [
      { role: "user", text: "財團法人婦女權益促進發展基金會是誰" },
      { role: "model", text: "（回答）" },
      { role: "user", text: "你有幾個兄弟姊妹？" },
      { role: "model", text: "（回答）" },
    ];
    expect(expandQuery("你確定沒寫？？", real)).toBe("你有幾個兄弟姊妹？ 你確定沒寫？？");
  });

  it("空字串安全", () => {
    expect(expandQuery("   ", history)).toBe("");
  });

  it("擴展句的組法只有 withAnchor 一份：expandQuery 的輸出與它一致", () => {
    expect(withAnchor("那後來呢？", "婦女新知基金會是怎麼開始的？")).toBe("婦女新知基金會是怎麼開始的？ 那後來呢？");
    expect(expandQuery("那後來呢？", history)).toBe(withAnchor("那後來呢？", "婦女新知基金會是怎麼開始的？"));
  });
});
