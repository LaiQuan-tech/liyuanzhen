import { describe, it, expect } from "vitest";
import { deriveAvatarState } from "./types";

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
