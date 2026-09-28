import { describe, it, expect } from "vitest";
import {
  cleanSpokenQuery,
  expandQuery,
  findAnchor,
  isFollowUp,
  needsContext,
  withAnchor,
  type HistoryTurn,
} from "./query-expansion";

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
  // 審查探針：含「請問」「那個」的完整問題，清過之後也不是追問
  "請問婦女新知是哪一年成立的",
  "那個年代女生可以念大學嗎",
  "請問一下李元貞是不是昆明人",
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

/**
 * 規則 d：質疑／更正，只收「指向對方剛說的話」的句型。只拿質疑句本身檢索會撈到網站說明〈它會答錯嗎〉，
 * 數位人就照那段撤回正確答案；接上緊鄰的上一題當錨點，才撈得回原本答案的出處。
 * 前 6 句是 Q 組與查核實際出現的句子。
 */
const CHALLENGES = [
  "明明是2005年出的 妳搞錯了吧", // Q-06
  "不是吧 我記得是2000年以後才修的", // Q-05
  "妳是台大老師吧 妳記錯了",
  "妳記錯了吧 明明是1985年", // Q-01
  "不對 妳是昆明人啦 維基百科都這樣寫", // Q-02
  "妳剛剛說錯了 妳是台大的老師", // Q-03：主詞與「說錯」之間隔著「剛剛」
  "妳錯了",
  "妳說的不對",
  "妳是不是記錯了",
  "妳會不會記錯了", // 有「了」：在說剛才那一次
  "妳記錯年份了",
  "錯了啦 是1985年", // 句首的「錯了」＋語氣詞
  "不對不對 妳是昆明人",
  "不是啦 我是問妳媽媽",
  "不是這樣 是1985年",
  "應該是1985年才對", // 是＋年份…才對
];

/**
 * 刻意漏判：確實是在質疑剛才的答案，但句型跟完整的新問題分不開，寧可漏判（漏判只是退回原句檢索，
 * 9/22 驗過安全），不可誤判（誤判會把新問題黏上前一題）。要放寬任何一條，先看它對應的反例。
 */
const ACCEPTED_MISSES = [
  "書裡明明有寫", // ↔「法律明明有寫男女平等為什麼還有歧視」
  "明明是昆明 妳幹嘛說景東", // 「明明…妳」整條拿掉 ↔「明明妳是教授 為什麼還被警總約談」
  "妳明明說過是1982年", // 「妳明明說」整條拿掉 ↔「妳明明寫過很多詩 為什麼說自己不是詩人」
  "明明是一九八五年", // 只認阿拉伯數字年份 ↔「明明是三十歲才結婚 為什麼被說晚婚」
  "我覺得妳剛剛講的不對", // 主詞前有「覺得」 ↔「當年離婚 妳覺得妳錯了嗎」
  "不對 那是哪一年", // 帶疑問詞 ↔「女人明明做一樣的工作 你們當年怎麼爭取同工同酬」
  "妳記錯了嗎", // 第十五輪：帶「嗎」一律不算 ↔「我記得是妳寫的〈花蓮的女兒〉 可以念給我聽嗎」
];

/**
 * 質疑詞在講別的人、別的事——完整的新問題，接上一題只會被污染。
 * 前 14 句是兩輪獨立審查實跑抓到的誤判（當時的規則 d 都判成追問，9/22 修掉的污染又出現）。
 */
const NOT_CHALLENGES = [
  // 第二輪審查（寧可漏判，不可誤判）
  "明明妳是教授 為什麼還被警總約談",
  "女人明明做一樣的工作 你們當年怎麼爭取同工同酬",
  "當年離婚 妳覺得妳錯了嗎", // 主詞前有「覺得」：在問她的看法
  "妳明明寫過很多詩 為什麼說自己不是詩人",
  "明明是三十歲才結婚 為什麼被說晚婚",
  // 第一輪審查
  "妳覺得為什麼女人明明有能力卻升不上去",
  "為什麼女人明明是受害者還被責怪",
  "女人應該怎麼做才對",
  "我應該怎麼跟女兒溝通才對",
  "年輕人說錯話了怎麼辦",
  "政府當年到底哪裡搞錯了",
  "妳覺得傳統觀念都錯了嗎",
  "這個不對等的社會要怎麼改變",
  "妳覺得女人應該怎麼做才對", // 被當成追問的話，findAnchor 會跳過它，下一句「那後來呢？」就找不到錨點
  "婚姻中夫妻應該怎麼相處才對",
  "妳覺得當年的立委搞錯了什麼",
  "妳會怕講錯話嗎",
  "明明有能力的女人為什麼還是被歧視",
  "明明就是性騷擾 為什麼大家不相信",
  "女人明明很努力 妳覺得為什麼還是被看不起", // 明明…妳覺得：是在問她的看法
  "法律明明有寫男女平等為什麼還有歧視", // 「明明有寫」不收的原因
  "不是，我想問另一件事", // 光「不是，」不收
  "明明是一種歧視吧", // 單一個「一」不算數字
  "妳覺得女人不對嗎", // 「不對」的主詞是女人，不是對方剛說的話
  "我做錯了什麼", // 做錯是行為的錯
  "婦女新知當年有做錯什麼決定嗎",
  "妳後悔過自己做錯的事嗎",
  "妳說錯過什麼話嗎", // 說錯後面緊接「過什麼」：在問新的事
  "妳講的都是對的嗎 會不會說錯", // eval K-04：泛問 AI 會不會錯，正解在〈它會答錯嗎〉，不能接上一題
  "女人要獨立才對", // 「要…才對」是規範句
  "妳明明很成功為什麼還這麼謙虛", // 「明明很」是加強語氣
  "這個說法對不對", // 「對不對」是附加問句
  "沒錯 就是1982年", // 沒錯＝對
  // 🔴 第十五輪（複審實跑）：帶著新的請求（多說、介紹、想問、想知道…）或問句語氣（嗎、呢）——在 9/28 以前是 false，
  // 規則 d 加進來之後變 true，新的主題被黏到上一題。前 2 句是複審列的原句。
  "我記得是1987年的華西街遊行 妳可以多說一點嗎",
  "不對 我想問婦女新知", // 清口語包裝會拿掉「我想問」，所以新請求的判斷看原句
  "我記得是妳寫的〈花蓮的女兒〉 可以念給我聽嗎",
  "不對 我想知道婦女新知的事",
  "明明是2005年出的 妳搞錯了吧 可以介紹一下那本書嗎",
  "不是啦 可以跟我說說妳媽媽的事嗎",
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

  it.each(CHALLENGES)("規則 d：對著對方剛說的話質疑／更正，算追問：%s", (q) => {
    expect(needsContext(q)).toBe(true);
  });

  it.each(NOT_CHALLENGES)("規則 d：質疑詞在講別的事，不算追問：%s", (q) => {
    expect(needsContext(q)).toBe(false);
  });

  it.each(ACCEPTED_MISSES)("規則 d：刻意漏判（寧可漏判，不可誤判）：%s", (q) => {
    expect(needsContext(q)).toBe(false);
    expect(isFollowUp(q)).toBe(false);
  });

  it("規則 d：整句去標點超過 30 字就不算（一口氣講好幾件事）", () => {
    // 去掉空白後 39 字
    expect(needsContext("明明是2005年出的 妳搞錯了吧 我上網查過好幾個地方都寫2005年 妳要不要再查一下")).toBe(false);
  });

  it("規則 d：清單外的確認句維持原判（沒有質疑詞，像 Q-04「我記得妳的詩集是…對吧」）", () => {
    expect(needsContext("我記得妳的詩集是紅得發紫啦 對吧")).toBe(false);
    expect(needsContext("書裡是不是寫妳在淡水住了三十四年")).toBe(false);
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

  it("質疑句本身不當錨點：連續質疑兩次，第二次接的仍是原本的問題", () => {
    const history: HistoryTurn[] = [
      { role: "user", text: "妳寫的眾女成城是哪一年出版的" },
      { role: "model", text: "（回答）" },
      { role: "user", text: "明明是2005年出的 妳搞錯了吧" },
      { role: "model", text: "（回答）" },
    ];
    expect(findAnchor(history)).toBe("妳寫的眾女成城是哪一年出版的");
    expect(expandQuery("不對吧 我查過了", history)).toBe("妳寫的眾女成城是哪一年出版的 不對吧 我查過了");
  });

  it("含「才對」的完整問題不是追問，要能當錨點：下一句「那後來呢？」接得上", () => {
    for (const text of ["妳覺得女人應該怎麼做才對", "我想問一下 妳覺得女人應該怎麼做才對"]) {
      const history: HistoryTurn[] = [
        { role: "user", text },
        { role: "model", text: "（回答）" },
      ];
      expect(findAnchor(history)).toBe(text);
      expect(expandQuery("那後來呢？", history)).toBe(`${text} 那後來呢？`);
    }
  });

  it("口語的追問也不當錨點：歷史裡的「嗯 妳確定？」要跳過，接回原本的問題", () => {
    const history: HistoryTurn[] = [
      { role: "user", text: "妳有幾個兄弟姊妹？" },
      { role: "model", text: "（回答）" },
      { role: "user", text: "嗯 妳確定？" },
      { role: "model", text: "（回答）" },
    ];
    expect(findAnchor(history)).toBe("妳有幾個兄弟姊妹？");
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

  it("口語的追問也會擴展（跟 retrieve() 同一套判斷）；回傳的字串還沒清，送 embedding 前才清", () => {
    expect(expandQuery("老師，請問一下，那後來呢？", history)).toBe(
      "婦女新知基金會是怎麼開始的？ 老師，請問一下，那後來呢？"
    );
  });
});

describe("isFollowUp（檢索用的追問判斷＝清過口語包裝後的 needsContext）", () => {
  it("句首的贅詞與稱呼藏住了追問句型：原句判斷 false，清過之後是追問", () => {
    expect(needsContext("嗯 妳確定？")).toBe(false); // 頭詞不在句首
    expect(isFollowUp("嗯 妳確定？")).toBe(true);
    expect(needsContext("老師，請問一下，那後來呢？")).toBe(false); // 12 字，超過句尾「呢」的 10 字上限
    expect(isFollowUp("老師，請問一下，那後來呢？")).toBe(true);
    expect(isFollowUp("呃 妳記錯了吧 明明是1985年")).toBe(true);
  });

  it("規則 d 的新請求判斷看原句（第十五輪）：清掉「我想問」之後的句子單獨看是質疑，但訪客其實在問新的事", () => {
    expect(cleanSpokenQuery("不對 我想問婦女新知")).toBe("不對 婦女新知");
    expect(needsContext("不對 婦女新知")).toBe(true); // 只看清過的句子，就會被當成質疑
    expect(needsContext("不對 我想問婦女新知")).toBe(false);
    expect(isFollowUp("不對 我想問婦女新知")).toBe(false);
    // 追問（規則 a、c）不受這一道影響：請託外殼拿掉之後照樣是追問
    expect(isFollowUp("老師，請問一下，那後來呢？")).toBe(true);
    expect(isFollowUp("嗯 妳確定？")).toBe(true);
  });

  it("口語包裝裡的完整問題、整句都是包裝的招呼，仍然不是追問", () => {
    expect(isFollowUp("老師 妳怎麼看待婚姻")).toBe(false);
    expect(isFollowUp("李元真老師妳好妳可以跟我說一下妳小時候的事嗎")).toBe(false);
    expect(isFollowUp("妳剛剛講太快了 我聽不清楚 妳再講一次妳是哪裡人")).toBe(false);
    expect(isFollowUp("嗯")).toBe(false); // 清完太短用原句 → 應答語
    expect(isFollowUp("老師妳好")).toBe(false);
  });

  it.each([...FOLLOW_UPS, ...CHALLENGES])("原本就是追問的，清過之後仍是：%s", (q) => {
    expect(isFollowUp(q)).toBe(true);
  });

  it.each([...STANDALONE, ...NOT_CHALLENGES])("原本不是追問的，清過之後仍不是：%s", (q) => {
    expect(isFollowUp(q)).toBe(false);
  });
});

describe("cleanSpokenQuery", () => {
  it.each([
    // 要求重講
    ["妳剛剛講太快了 妳是哪裡人", "妳是哪裡人"],
    ["我聽不清楚 妳是哪裡人", "妳是哪裡人"],
    ["妳再講一次妳是哪裡人", "妳是哪裡人"],
    ["再說一遍 華西街遊行是哪一年", "華西街遊行是哪一年"],
    // 贅詞
    ["嗯 妳是哪裡人", "妳是哪裡人"],
    ["呃妳是哪裡人", "妳是哪裡人"],
    ["欸，妳是哪裡人", "妳是哪裡人"],
    ["那個 妳是哪裡人", "妳是哪裡人"],
    ["那個那個妳為什麼不結婚", "妳為什麼不結婚"],
    ["那個那個那個時候妳幾歲", "那個時候妳幾歲"], // 連續的留一個：最後那個是指示詞
    ["就是說妳是哪裡人", "妳是哪裡人"],
    ["妳是哪裡人 然後 妳爸爸做什麼", "妳是哪裡人 妳爸爸做什麼"],
    // 請託外殼
    ["請問一下妳是哪裡人", "妳是哪裡人"],
    ["我想問一下妳是哪裡人", "妳是哪裡人"],
    ["妳可以跟我說一下妳小時候的事嗎", "妳小時候的事嗎"],
    ["可以告訴我妳是哪裡人嗎", "妳是哪裡人嗎"],
    // 句首稱呼／招呼
    ["老師妳是哪裡人", "妳是哪裡人"],
    ["李老師，妳是哪裡人", "妳是哪裡人"],
    ["李元貞老師妳好 妳是哪裡人", "妳是哪裡人"],
    ["李元真老師妳好妳是哪裡人", "妳是哪裡人"],
    ["妳好 請問一下妳是哪裡人", "妳是哪裡人"],
  ])("去掉口語包裝：%s → %s", (input, expected) => {
    expect(cleanSpokenQuery(input)).toBe(expected);
  });

  it("V-07、S-03、S-04 三句", () => {
    expect(cleanSpokenQuery("妳剛剛講太快了 我聽不清楚 妳再講一次妳是哪裡人")).toBe("妳是哪裡人");
    expect(cleanSpokenQuery("李元真老師妳好妳可以跟我說一下妳小時候的事嗎")).toBe("妳小時候的事嗎");
    // 連續的「那個」留一個；句中單獨的「那個」不清（拿掉也沒有比較好，見 cleanSpokenQuery 的說明）
    expect(cleanSpokenQuery("那個那個華西街那個遊行是在幹嘛的")).toBe("那個華西街那個遊行是在幹嘛的");
  });

  it.each([
    "你是誰啊",
    "妳當初為什麼會想投入婦運",
    "妳寫過哪些書",
    "妳怎麼看婚姻",
    "可以給我們年輕人一些人生建議嗎",
    "我老公喝醉就會打我 我好怕 不知道怎麼辦",
    "妳覺得呂秀蓮這個人怎麼樣",
    "妳最近身體還好嗎",
    "那妳今年幾歲",
    "妳是那一年創辦婦女心知的",
  ])("一般問句清完等於原句：%s", (q) => {
    expect(cleanSpokenQuery(q)).toBe(q);
  });

  it.each([
    "那個時候妳幾歲？", // 那個＝指示詞
    "那個人是誰",
    "李元貞老師是哪裡人？", // 李元貞老師是主詞，不是在叫人
    "老師的書在哪裡買得到？",
    "妳好厲害 妳是怎麼做到的", // 「好」是副詞，不是招呼
    "妳好嗎",
    "然後呢？", // 追問，然後不是贅詞
    "我想問的是婦女新知怎麼開始的",
    "我想問題出在哪裡",
    "妳小時候耳朵聽不清楚嗎", // 沒有「我」：是內容，不是要求重講
    "她就是說她不想結婚嗎", // 句中的「就是說」＝就是說了
    "妳覺得婦運走得太快了嗎",
    "妳可以告訴我們妳的故事嗎",
    "那妳為什麼不結婚",
  ])("長得像包裝、其實是內容的不動：%s", (q) => {
    expect(cleanSpokenQuery(q)).toBe(q);
  });

  it("否定詞、疑問詞、人名一律留著", () => {
    expect(cleanSpokenQuery("嗯 妳為什麼不結婚")).toBe("妳為什麼不結婚");
    expect(cleanSpokenQuery("老師 妳什麼時候去淡江教書")).toBe("妳什麼時候去淡江教書");
    expect(cleanSpokenQuery("請問一下李元貞是哪裡人")).toBe("李元貞是哪裡人");
    expect(cleanSpokenQuery("呃 妳有幾個兄弟姊妹")).toBe("妳有幾個兄弟姊妹");
  });

  it("清完是空字串或不到 2 個字 → 用原句", () => {
    expect(cleanSpokenQuery("再說一遍")).toBe("再說一遍");
    expect(cleanSpokenQuery("老師妳好")).toBe("老師妳好");
    expect(cleanSpokenQuery("嗯嗯")).toBe("嗯嗯");
    expect(cleanSpokenQuery("可以再說一次嗎")).toBe("可以再說一次嗎");
    expect(cleanSpokenQuery("妳講話太快了 我聽不清楚 可以再說一次嗎")).toBe("妳講話太快了 我聽不清楚 可以再說一次嗎");
    expect(cleanSpokenQuery("嗯 好")).toBe("嗯 好"); // 清完只剩「好」一個字
  });

  it("被拿掉的包裝後面留下的逗號一起收掉；內容之間的逗號不動", () => {
    expect(cleanSpokenQuery("老師，請問一下，那後來呢？")).toBe("那後來呢？");
    expect(cleanSpokenQuery("婦女新知是哪一年成立的？ 老師，請問一下，那後來呢？")).toBe(
      "婦女新知是哪一年成立的？ 那後來呢？"
    );
    expect(cleanSpokenQuery("妳是哪裡人，嗯，妳爸爸做什麼")).toBe("妳是哪裡人，妳爸爸做什麼");
  });
});
