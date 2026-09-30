import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ANSWER_DISCLAIMER,
  SITE_NOTICE,
  AVATAR_NAME,
  OUT_OF_SCOPE_REPLY,
  GUARDED_REPLY,
  UNGROUNDED_REPLY,
  CRISIS_SELF_HARM_REPLY,
  CRISIS_VIOLENCE_REPLY,
  SMALLTALK_GREETING_REPLY,
  SMALLTALK_THANKS_REPLY,
  SMALLTALK_FAREWELL_REPLY,
  REFUSAL_PRIVACY_REPLY,
  REFUSAL_PROFANITY_REPLY,
  REFUSAL_HARASSMENT_REPLY,
  REFUSAL_MEDICAL_REPLY,
  REFUSAL_FINANCE_REPLY,
  REFUSAL_ERRAND_REPLY,
  REFUSAL_CREATION_REPLY,
  PRIVACY_REPLY,
  FALLBACK_REPLY,
  SMALLTALK_PRAISE_REPLY,
  VENTING_REPLY,
  REFUSAL_SYSTEM_REPLY,
  TAIL_REPLIES,
  nav,
  footerLinks,
} from "@/content/site";
import { checkAnswer } from "@/lib/answer-guard";

/**
 * 把「哪些話用第一人稱、哪些話必須維持第三人稱」寫成可執行的規格。
 *
 * 判準只有一個：**這句話會不會被她的聲音唸出來。**
 *
 * - 分身自己說的話（婉拒、封鎖、求助危機回覆）→ 走 speakableAnswer → TTS → 第一人稱
 * - 揭露層（免責、頁尾聲明、頭像名稱）→ 畫面文字，不會唸 → 必須維持第三人稱
 *
 * 🔴 揭露層維持第三人稱不是疏漏，那是它有效的原因：它必須聽起來是**網站在說話**，
 * 不是她在說話。把「非李元貞老師本人發言」改成第一人稱，等於讓聲明本身
 * 也變成角色的一部分——那會真的削弱誠實框架。
 */
describe("文案的人稱分工", () => {
  it("🔴 揭露層必須維持第三人稱——它是網站在說話，不是她", () => {
    expect(ANSWER_DISCLAIMER).toContain("非李元貞老師本人發言");
    expect(SITE_NOTICE).toContain("不是李元貞老師本人");
    // 頭像名稱永遠帶著「AI 模擬」，不做成可關閉的橫幅
    expect(AVATAR_NAME).toContain("AI 模擬");
  });

  it("分身自己說的話一律第一人稱，不可以用第三人稱指自己", () => {
    for (const [name, line] of [
      ["OUT_OF_SCOPE_REPLY", OUT_OF_SCOPE_REPLY],
      ["GUARDED_REPLY", GUARDED_REPLY],
      ["UNGROUNDED_REPLY", UNGROUNDED_REPLY],
      ["CRISIS_SELF_HARM_REPLY", CRISIS_SELF_HARM_REPLY],
      ["SMALLTALK_THANKS_REPLY", SMALLTALK_THANKS_REPLY],
      ["REFUSAL_PRIVACY_REPLY", REFUSAL_PRIVACY_REPLY],
      ["REFUSAL_PROFANITY_REPLY", REFUSAL_PROFANITY_REPLY],
      ["REFUSAL_HARASSMENT_REPLY", REFUSAL_HARASSMENT_REPLY],
      ["REFUSAL_MEDICAL_REPLY", REFUSAL_MEDICAL_REPLY],
      ["REFUSAL_FINANCE_REPLY", REFUSAL_FINANCE_REPLY],
      ["REFUSAL_ERRAND_REPLY", REFUSAL_ERRAND_REPLY],
      ["REFUSAL_CREATION_REPLY", REFUSAL_CREATION_REPLY],
      ["PRIVACY_REPLY", PRIVACY_REPLY],
      ["FALLBACK_REPLY", FALLBACK_REPLY],
      ["SMALLTALK_PRAISE_REPLY", SMALLTALK_PRAISE_REPLY],
      ["VENTING_REPLY", VENTING_REPLY],
      ["REFUSAL_SYSTEM_REPLY", REFUSAL_SYSTEM_REPLY],
    ] as const) {
      expect(line, name).toContain("我");
      // ⚠️ 這兩句以前寫「我能談的是李元貞老師的生平」——第一人稱語氣配第三人稱自稱
      expect(line, name).not.toContain("李元貞");
    }
    // ⚠️ CRISIS_VIOLENCE_REPLY 整句都在對「你」說話、沒有自稱（文字照專案擁有者定稿），
    // 所以不驗「含我」；但它一樣用她的聲音唸出來，不可以用第三人稱指自己這條照樣要守。
    expect(CRISIS_VIOLENCE_REPLY).not.toContain("李元貞");
    // 道別那句同上：整句在對「你」說話、沒有自稱
    expect(SMALLTALK_FAREWELL_REPLY).not.toContain("李元貞");
    // ⚠️ 招呼那句是 AI 分身在介紹自己，「李元貞老師」指的是真人（見 content/site.ts 上方註解），
    // 所以不驗「不含李元貞」；改驗它是第一人稱、而且一定講明自己是 AI 分身。
    expect(SMALLTALK_GREETING_REPLY).toContain("我");
    expect(SMALLTALK_GREETING_REPLY).toContain("AI 分身");
  });

  /** 寒暄回覆會被唸出來、當字幕，要短（需求：60 字以內，不算空白） */
  it("寒暄與拒絕回覆 60 字以內（含醫療、理財、代勞、創作、隱私攔截、讚美、同理備援、系統架構）", () => {
    for (const line of [
      PRIVACY_REPLY,
      VENTING_REPLY,
      SMALLTALK_PRAISE_REPLY,
      SMALLTALK_GREETING_REPLY,
      SMALLTALK_THANKS_REPLY,
      SMALLTALK_FAREWELL_REPLY,
      REFUSAL_PRIVACY_REPLY,
      REFUSAL_PROFANITY_REPLY,
      REFUSAL_HARASSMENT_REPLY,
      REFUSAL_MEDICAL_REPLY,
      REFUSAL_FINANCE_REPLY,
      REFUSAL_ERRAND_REPLY,
      REFUSAL_CREATION_REPLY,
      REFUSAL_SYSTEM_REPLY,
    ]) {
      expect(Array.from(line.replace(/\s/g, "")).length, line).toBeLessThanOrEqual(60);
    }
  });

  /**
   * 🔴 求助專線號碼一個都不能改、也不能多（理由見 content/site.ts 兩句上方的註解）。
   * 逐一釘住兩句裡出現的每一個數字：改了號碼、或加了語料外的其他專線，這裡就會紅。
   */
  it("求助危機回覆裡的號碼一個都不能改、也不能多", () => {
    expect(CRISIS_SELF_HARM_REPLY.match(/\d+/g)).toEqual(["1925", "24", "1995", "119"]);
    expect(CRISIS_VIOLENCE_REPLY.match(/\d+/g)).toEqual(["110", "113", "24"]);
  });

  /**
   * 使用者回報：舊版婉拒詞列三個抽象類別（生平／創辦過程／婦運歷程），
   * 讀起來像「我們資料庫只有這些」。改成點名具體的事件與年份。
   * ⚠️ 這幾樣都確認過檢索得到；日後改語料要回來確認還在。
   */
  it("婉拒詞要點名具體的事，不是抽象類別", () => {
    expect(OUT_OF_SCOPE_REPLY).toContain("1982");
    expect(OUT_OF_SCOPE_REPLY).toContain("華西街");
    expect(OUT_OF_SCOPE_REPLY).toContain("花蓮");
  });

  /**
   * 🔴 2026-09-25：婉拒詞也要守 lib/persona-prompt.ts 規則 8 的 100 字上限——它跟模型的回答
   * 用同一個聲音、同一個字幕框出現。舊版含標點 111 字。量法同 scripts/eval-public.ts（不含空白）。
   * 縮短不可以把「只講有出處的事」這個說明縮掉：那是這句婉拒的理由，也是它跟「資料庫很少」的差別。
   */
  it("婉拒詞不超過 100 字（含標點、不含空白），而且還在說「只講有出處的事」", () => {
    expect(Array.from(OUT_OF_SCOPE_REPLY.replace(/\s+/g, "")).length).toBeLessThanOrEqual(100);
    expect(OUT_OF_SCOPE_REPLY).toContain("我只講有出處的事，不能隨口編");
  });

  it("會被 TTS 唸出來的句子不可以有 Markdown 符號", () => {
    for (const line of [
      OUT_OF_SCOPE_REPLY,
      GUARDED_REPLY,
      UNGROUNDED_REPLY,
      CRISIS_SELF_HARM_REPLY,
      CRISIS_VIOLENCE_REPLY,
      SMALLTALK_GREETING_REPLY,
      SMALLTALK_THANKS_REPLY,
      SMALLTALK_FAREWELL_REPLY,
      REFUSAL_PRIVACY_REPLY,
      REFUSAL_PROFANITY_REPLY,
      REFUSAL_HARASSMENT_REPLY,
      REFUSAL_MEDICAL_REPLY,
      REFUSAL_FINANCE_REPLY,
      REFUSAL_ERRAND_REPLY,
      REFUSAL_CREATION_REPLY,
      PRIVACY_REPLY,
      FALLBACK_REPLY,
      SMALLTALK_PRAISE_REPLY,
      VENTING_REPLY,
      REFUSAL_SYSTEM_REPLY,
    ]) {
      expect(line).not.toMatch(/[*#`]|^\s*[-•]/m);
    }
  });

  /**
   * 第十輪、第十一輪：route 會接在已送出的半段後面的句子，ChatPanel／LiveStage 都要認得（只唸那一句）。
   * 少一句，那種情境下被攔下或失敗的前半段就會被唸出去。
   */
  it("TAIL_REPLIES 收齊 route 會接在半段後面的每一句", () => {
    for (const reply of [
      GUARDED_REPLY,
      UNGROUNDED_REPLY,
      PRIVACY_REPLY,
      FALLBACK_REPLY,
      CRISIS_SELF_HARM_REPLY,
      CRISIS_VIOLENCE_REPLY,
      VENTING_REPLY,
      REFUSAL_SYSTEM_REPLY,
    ]) {
      expect(TAIL_REPLIES).toContain(reply);
    }
  });

  /**
   * 2026-09-29 同理備援：訪客在抒發情緒、模型原答被落地率攔下時送這句（app/api/chat/route.ts）。
   * 它跟危機回覆一樣「不依語料」說出口，所以不可以帶任何事實（數字、書名、人名、年份），不可以替訪客做決定，
   * 也不可以以問句收尾（lib/smalltalk.test.ts 另外驗 modelInvites 對它回 false）。
   */
  it("同理備援不帶事實、不替訪客做決定、不以問句收尾", () => {
    expect(VENTING_REPLY).not.toMatch(/\d|[一二三四五六七八九十]+年|《|〈|婦女新知|李元貞|元晶/);
    expect(VENTING_REPLY).not.toMatch(/(你|妳)(就)?(應該|該|必須|一定要|最好|要不要)/);
    expect(VENTING_REPLY).toContain("我沒辦法替你做決定");
    expect(VENTING_REPLY.trim()).not.toMatch(/[？?嗎呢]$/);
  });

  /**
   * 🔴 第十輪：讚美回覆裡「婦運是許多人一起走出來的路，不是我一個人的功勞」是她在語料裡的說法，不是站方新加的主張。
   * 出處釘在這裡：改語料時把這幾句拿掉，這裡會紅——那時回覆也要改成不含事實的說法。
   */
  it("讚美回覆的「婦運是集體的成果」在語料裡有出處", () => {
    const dir = resolve(__dirname, "knowledge");
    const corpus = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(resolve(dir, f), "utf8"))
      .join("\n");
    expect(SMALLTALK_PRAISE_REPLY).toContain("婦運是許多人一起走出來的路");
    expect(corpus).toContain("婦女新知從來不是一個人的事業"); // 03-movement-timeline.md:25
    expect(corpus).toContain("強調婦運是集體的成果"); // 03-movement-timeline.md:29
    expect(corpus).toContain("台灣婦女運動不是靠某一個人完成的"); // 04-thought.md:54
  });

  /**
   * 🔴 2026-09-30：系統架構與資料隱私的迴避句要點名網站上真的看得到的兩頁——導覽列與頁尾的「資訊聲明」、頁尾的「隱私權」。
   * 從 nav／footerLinks 的 label 取：改了 label 沒回來改這句，這裡會紅（講一個畫面上找不到的頁名，等於沒指路）。
   * 不寫「網站下方」：/live4 刻意不掛 Nav 與 Footer。它自己也不可以含任何技術名詞——要過得了護欄的 system 類。
   */
  it("系統架構的迴避句點名網站上真的看得到的頁名、不講位置、不含技術名詞", () => {
    const about = nav.find((item) => item.href === "/about-ai");
    const privacy = footerLinks.find((item) => item.href === "/privacy");
    expect(about?.label).toBe("資訊聲明");
    expect(privacy?.label).toBe("隱私權");
    expect(REFUSAL_SYSTEM_REPLY).toContain(`「${about?.label}」`);
    expect(REFUSAL_SYSTEM_REPLY).toContain(`「${privacy?.label}」`);
    expect(REFUSAL_SYSTEM_REPLY).not.toMatch(/下方|頁尾|底下/);
    expect(checkAnswer(`${REFUSAL_SYSTEM_REPLY}\n`).blocked).toBe(false);
    expect(REFUSAL_SYSTEM_REPLY).not.toMatch(/[A-Za-z]/);
  });
});
