import { describe, it, expect } from "vitest";
import {
  ANSWER_DISCLAIMER,
  SITE_NOTICE,
  AVATAR_NAME,
  OUT_OF_SCOPE_REPLY,
  GUARDED_REPLY,
} from "@/content/site";

/**
 * 把「哪些話用第一人稱、哪些話必須維持第三人稱」寫成可執行的規格。
 *
 * 判準只有一個：**這句話會不會被她的聲音唸出來。**
 *
 * - 分身自己說的話（婉拒、封鎖）→ 走 speakableAnswer → TTS → 第一人稱
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
    ] as const) {
      expect(line, name).toContain("我");
      // ⚠️ 這兩句以前寫「我能談的是李元貞老師的生平」——第一人稱語氣配第三人稱自稱
      expect(line, name).not.toContain("李元貞");
    }
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

  it("會被 TTS 唸出來的句子不可以有 Markdown 符號", () => {
    for (const line of [OUT_OF_SCOPE_REPLY, GUARDED_REPLY]) {
      expect(line).not.toMatch(/[*#`]|^\s*[-•]/m);
    }
  });
});
