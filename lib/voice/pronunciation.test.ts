import { describe, it, expect } from "vitest";
import { fixPronunciation, PRONUNCIATION_FIXES } from "./pronunciation";

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
});
