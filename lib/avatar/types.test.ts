import { describe, it, expect } from "vitest";
import { deriveAvatarState, speakableAnswer } from "./types";
import { GUARDED_REPLY } from "@/content/site";

/**
 * 這幾條守的是一個真的發生過的 bug：
 * 原本 avatarState 是一個 useState，由 send() 與 TTS 的 onState 兩個 writer 搶著寫，
 * 防護寫成 `prev === "thinking" ? prev : …` → 一旦進 thinking 就出不來。
 * 症狀是開啟朗讀後頭像永遠停在「正在查資料…」，「停止」按鈕永遠不出現。
 */
describe("deriveAvatarState", () => {
  it("閒著就是 idle", () => {
    expect(deriveAvatarState(false, false)).toBe("idle");
  });

  it("在等回應但還沒開口 → thinking", () => {
    expect(deriveAvatarState(false, true)).toBe("thinking");
  });

  it("⚠️ 串流還沒結束但已經開口 → speaking（thinking 不可以蓋掉它）", () => {
    expect(deriveAvatarState(true, true)).toBe("speaking");
  });

  it("⚠️ 串流結束但還在唸 → 仍是 speaking，不是 idle", () => {
    // busy 在 finally 就被設回 false，朗讀卻還在跑
    expect(deriveAvatarState(true, false)).toBe("speaking");
  });

  it("唸完就回 idle——必須真的回得去", () => {
    expect(deriveAvatarState(false, false)).toBe("idle");
  });

  it("speaking 是可達的狀態（停止鈕 gate 在它上面）", () => {
    const reachable = [
      deriveAvatarState(true, true),
      deriveAvatarState(true, false),
    ];
    expect(reachable.every((s) => s === "speaking")).toBe(true);
  });
});

/**
 * 這幾條守的是一個「還沒發生、但一旦發生就無法收拾」的問題。
 *
 * answer-guard 會回收已經送出的文字：命中封鎖清單時停止輸出，路由再追加
 * GUARDED_REPLY。等整段才開口的 driver 如果照著整段唸，就會把系統事後
 * 判定為不該說的那段唸出去——用老師的臉、老師的聲音。
 */
describe("speakableAnswer", () => {
  it("正常答案原封不動", () => {
    const answer = "《婦女新知》創刊於 1982 年，是台灣婦運的重要起點。";
    expect(speakableAnswer(answer, GUARDED_REPLY)).toBe(answer);
  });

  it("⚠️ 結尾是婉拒句時，只唸婉拒句——被回收的那段不可以出聲", () => {
    const recalled = "我支持的候選人是";
    expect(speakableAnswer(recalled + GUARDED_REPLY, GUARDED_REPLY)).toBe(
      GUARDED_REPLY
    );
  });

  it("整段就是婉拒句時也只唸婉拒句", () => {
    expect(speakableAnswer(GUARDED_REPLY, GUARDED_REPLY)).toBe(GUARDED_REPLY);
  });

  it("尾端有空白／換行仍然要認得出來", () => {
    expect(speakableAnswer(`前段${GUARDED_REPLY}\n  `, GUARDED_REPLY)).toBe(
      GUARDED_REPLY
    );
  });

  it("婉拒句只出現在中間不算——那是正常內容的一部分", () => {
    const answer = `${GUARDED_REPLY}不過我可以談談婦女新知的創辦。`;
    expect(speakableAnswer(answer, GUARDED_REPLY)).toBe(answer);
  });

  it("沒有給婉拒句時不做任何事（防呆，不是正常路徑）", () => {
    expect(speakableAnswer("任何字", "")).toBe("任何字");
  });
});
