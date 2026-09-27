import { describe, it, expect } from "vitest";
import { fixPronunciation, PRONUNCIATION_FIXES } from "./pronunciation";
import { CRISIS_SELF_HARM_REPLY, CRISIS_VIOLENCE_REPLY } from "@/content/site";

describe("fixPronunciation", () => {
  it("把「婦」換成同音的四聲字", () => {
    expect(fixPronunciation("婦女新知")).toBe("富女新知");
  });

  it("一句話裡出現幾次就換幾次", () => {
    expect(fixPronunciation("婦女新知、婦女運動、婦權會")).toBe(
      "富女新知、富女運動、富權會"
    );
  });

  it("沒有要換的字就原封不動", () => {
    const s = "我在一九八二年創辦了那本雜誌。";
    expect(fixPronunciation(s)).toBe(s);
  });

  it("空字串不會爆", () => {
    expect(fixPronunciation("")).toBe("");
  });

  /**
   * ⚠️ 這條在守一個很容易被踩到的坑：有人用正規表達式改寫 fixPronunciation
   * 之後，帶正規符號的條目就會靜默換錯。表裡的字串是資料，不是樣式。
   */
  it("表裡的字串當純文字處理，不當正規表達式", () => {
    expect(fixPronunciation("a.c")).toBe("a.c");
    expect(fixPronunciation("(婦)")).toBe("(富)");
  });

  it("表裡不能有把自己換成自己的條目（那是無效條目）", () => {
    for (const [from, to] of PRONUNCIATION_FIXES) {
      expect(from).not.toBe(to);
    }
  });

  /**
   * ⚠️ 換出來的字如果又是另一條的來源，套用順序就會影響結果，
   * 那種表沒有人看得懂。禁掉。
   */
  it("換出來的字不會再被後面的條目換掉", () => {
    const sources = PRONUNCIATION_FIXES.map(([from]) => from);
    for (const [, to] of PRONUNCIATION_FIXES) {
      for (const s of sources) {
        expect(to.includes(s)).toBe(false);
      }
    }
  });

  /**
   * 求助危機回覆（content/site.ts）裡的專線號碼要逐字唸，不可以唸成「一百一十三」。
   *
   * 🔴 表裡換的是確切片語（「打 110」「113 保護專線」…）。那兩句哪天改了號碼旁邊的字，
   * 片語就對不上、號碼會原封不動送進合成——這一條就是為了在那時候變紅。
   * 「24 小時」是時長，本來就該唸成「二十四小時」，不在替換之列，比對前先拿掉。
   */
  it("求助危機回覆換完之後，除了「24 小時」不剩任何阿拉伯數字", () => {
    for (const line of [CRISIS_SELF_HARM_REPLY, CRISIS_VIOLENCE_REPLY]) {
      const spoken = fixPronunciation(line);
      expect(spoken, line).toContain("24 小時");
      expect(spoken.replaceAll("24 小時", ""), line).not.toMatch(/\d/);
    }
  });

  it("求助專線換成逐字唸法", () => {
    const selfHarm = fixPronunciation(CRISIS_SELF_HARM_REPLY);
    expect(selfHarm).toContain("一九二五安心專線");
    expect(selfHarm).toContain("一九九五生命線");
    expect(selfHarm).toContain("打一一九");
    const violence = fixPronunciation(CRISIS_VIOLENCE_REPLY);
    expect(violence).toContain("打一一零");
    expect(violence).toContain("一一三保護專線");
  });

  /** 🔴 只換確切片語、不換裸數字：民國年與西元年在一般回答裡到處都是 */
  it("民國年與西元年不受影響", () => {
    for (const s of ["民國 110 年", "民國 113 年", "1995 年", "1925 年", "1995年"]) {
      expect(fixPronunciation(s)).toBe(s);
    }
  });
});
