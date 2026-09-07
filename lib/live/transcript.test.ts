import { describe, it, expect } from "vitest";
import { looksLikeSpeech } from "@/lib/live/transcript";

/**
 * 這一支的案例不是想像出來的——前四個是正式站 interactions 表裡真的出現過的
 * 問題文字。「00:00」出現了 8 次。
 */
describe("逐字稿是不是一句話", () => {
  it("🔴 語音辨識把靜音轉成的垃圾要擋下來", () => {
    // 這幾個都是正式站真的收到過的
    expect(looksLikeSpeech("00:00")).toBe(false);
    expect(looksLikeSpeech("3")).toBe(false);
    expect(looksLikeSpeech("")).toBe(false);
    expect(looksLikeSpeech("   ")).toBe(false);
  });

  it("純標點與符號也不是話", () => {
    expect(looksLikeSpeech("。。。")).toBe(false);
    expect(looksLikeSpeech("...")).toBe(false);
    expect(looksLikeSpeech("？")).toBe(false);
    expect(looksLikeSpeech("00:00:15")).toBe(false);
  });

  /**
   * ⚠️ 這一組比上面那組重要：誤擋一個真的問題，比放行一筆垃圾嚴重得多。
   * 特別是含大量數字的那幾題——它們是這個站最典型的提問。
   */
  it("含很多數字的正常問題不可以被誤擋", () => {
    expect(looksLikeSpeech("1982 年為什麼辦婦女新知？")).toBe(true);
    expect(looksLikeSpeech("1987")).toBe(false); // 只有年份沒有字，確實不是問題
    expect(looksLikeSpeech("1987 年發生什麼事")).toBe(true);
    expect(looksLikeSpeech("民法親屬編是哪一年修的？")).toBe(true);
  });

  it("英文問題也要放行", () => {
    expect(looksLikeSpeech("Who are you?")).toBe(true);
    expect(looksLikeSpeech("hi")).toBe(true);
  });

  it("很短但是有字的要放行——短不等於沒意義", () => {
    expect(looksLikeSpeech("你好")).toBe(true);
    expect(looksLikeSpeech("嗨")).toBe(true);
  });
});
