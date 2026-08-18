import { describe, it, expect } from "vitest";
import {
  deriveLiveState,
  avatarStateFor,
  canStartRecording,
  isRecording,
  isBusy,
  type LiveFacts,
} from "./state";

const base: LiveFacts = { recording: false, phase: "idle", speaking: false, errored: false };
const facts = (overrides: Partial<LiveFacts>): LiveFacts => ({ ...base, ...overrides });

describe("deriveLiveState", () => {
  it("什麼都沒發生就是 idle", () => {
    expect(deriveLiveState(base)).toBe("idle");
  });

  it("各個單一事實對應到各自的狀態", () => {
    expect(deriveLiveState(facts({ recording: true }))).toBe("recording");
    expect(deriveLiveState(facts({ phase: "transcribing" }))).toBe("transcribing");
    expect(deriveLiveState(facts({ phase: "thinking" }))).toBe("thinking");
    expect(deriveLiveState(facts({ speaking: true }))).toBe("speaking");
    expect(deriveLiveState(facts({ errored: true }))).toBe("error");
  });

  it("⚠️ recording 贏過所有其他事實——按下去的當下畫面必須立刻回應", () => {
    // 她還在講話時按下去就是要打斷她，這時顯示「回答中」是錯的
    expect(
      deriveLiveState({ recording: true, phase: "thinking", speaking: true, errored: true })
    ).toBe("recording");
  });

  it("speaking 贏過 phase——串流沒結束但已開口時要顯示回答中", () => {
    expect(deriveLiveState(facts({ phase: "thinking", speaking: true }))).toBe("speaking");
  });

  it("errored 排最後：任何新的活動都要蓋過上一輪的殘留", () => {
    expect(deriveLiveState(facts({ errored: true, phase: "transcribing" }))).toBe("transcribing");
    expect(deriveLiveState(facts({ errored: true, speaking: true }))).toBe("speaking");
    expect(deriveLiveState(facts({ errored: true, recording: true }))).toBe("recording");
  });

  it("⚠️ 沒有任何組合會回傳意料之外的值——這是死鎖防護", () => {
    // deriveAvatarState 的註解記著那個 bug：一旦進 thinking 就再也出不來。
    // 純函式的好處就是可以窮舉。
    const allowed = new Set(["idle", "recording", "transcribing", "thinking", "speaking", "error"]);
    for (const recording of [true, false]) {
      for (const phase of ["idle", "transcribing", "thinking"] as const) {
        for (const speaking of [true, false]) {
          for (const errored of [true, false]) {
            const state = deriveLiveState({ recording, phase, speaking, errored });
            expect(allowed.has(state)).toBe(true);
          }
        }
      }
    }
  });

  it("⚠️ 所有事實歸零一定回得到 idle——出不去就是死鎖", () => {
    expect(deriveLiveState(base)).toBe("idle");
  });
});

describe("avatarStateFor", () => {
  it("speaking → speaking", () => {
    expect(avatarStateFor("speaking")).toBe("speaking");
  });

  it("伺服器往返中 → thinking", () => {
    expect(avatarStateFor("transcribing")).toBe("thinking");
    expect(avatarStateFor("thinking")).toBe("thinking");
  });

  it("⚠️ 錄音中 → idle 而不是 thinking：訪客講話時她該在聽，不是在查資料", () => {
    expect(avatarStateFor("recording")).toBe("idle");
  });

  it("idle 與 error 都是 idle", () => {
    expect(avatarStateFor("idle")).toBe("idle");
    expect(avatarStateFor("error")).toBe("idle");
  });
});

describe("canStartRecording", () => {
  it("待機時可以按", () => {
    expect(canStartRecording("idle")).toBe(true);
  });

  it("⚠️ 她講話中可以按——那是打斷，是刻意允許的", () => {
    // Sunny 展場版沒做打斷，症狀是兩段語音重疊
    expect(canStartRecording("speaking")).toBe(true);
  });

  it("上一輪出錯後可以直接再問", () => {
    expect(canStartRecording("error")).toBe(true);
  });

  it("⚠️ 伺服器往返中不可以按——會出現兩個並行請求，回應順序無法保證", () => {
    expect(canStartRecording("transcribing")).toBe(false);
    expect(canStartRecording("thinking")).toBe(false);
  });

  it("已經在錄音時不可以重複開始", () => {
    expect(canStartRecording("recording")).toBe(false);
  });
});

describe("isRecording / isBusy", () => {
  it("isRecording 只有錄音中為真", () => {
    expect(isRecording("recording")).toBe(true);
    for (const state of ["idle", "transcribing", "thinking", "speaking", "error"] as const) {
      expect(isRecording(state), state).toBe(false);
    }
  });

  it("isBusy 只涵蓋伺服器往返，不含錄音與朗讀", () => {
    expect(isBusy("transcribing")).toBe(true);
    expect(isBusy("thinking")).toBe(true);
    for (const state of ["idle", "recording", "speaking", "error"] as const) {
      expect(isBusy(state), state).toBe(false);
    }
  });
});
