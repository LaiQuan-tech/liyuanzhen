import { describe, it, expect } from "vitest";
import {
  deriveLiveState,
  avatarStateFor,
  canStartRecording,
  isRecording,
  isBusy,
  talkButtonAction,
  TAP_DEBOUNCE_MS,
  type LiveFacts,
  type LiveState,
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

describe("talkButtonAction（切換式按鈕的分派）", () => {
  it("待機、講話中、上一輪出錯 → 開始錄音", () => {
    for (const state of ["idle", "speaking", "error"] as const) {
      expect(talkButtonAction(state, null), state).toBe("start");
    }
  });

  it("錄音中 → 送出", () => {
    expect(talkButtonAction("recording", 3000)).toBe("stop");
  });

  it("伺服器往返中 → 什麼都不做", () => {
    // 按鈕上有 disabled，但那只擋滑鼠與鍵盤；程式化的 click 擋不住，
    // 所以這裡必須是第二道。
    for (const state of ["transcribing", "thinking"] as const) {
      expect(talkButtonAction(state, null), state).toBe("ignore");
    }
  });

  it("🔴 開始後 500ms 內的第二下要被吞掉，不可以送出", () => {
    // 緊張的人會連點兩下。第二下被當成送出的話，他得到的是 0.3 秒的錄音
    // 加一句「沒收到聲音」——而連點兩下在按住式裡是完全正常的動作。
    expect(talkButtonAction("recording", 0)).toBe("ignore");
    expect(talkButtonAction("recording", 120)).toBe("ignore");
    expect(talkButtonAction("recording", TAP_DEBOUNCE_MS - 1)).toBe("ignore");
  });

  it("剛好到 500ms 就可以送出了", () => {
    expect(talkButtonAction("recording", TAP_DEBOUNCE_MS)).toBe("stop");
  });

  it("錄音中但不知道開始多久（null）→ 照樣送出", () => {
    // 不知道 ≠ 剛開始。ref 掉了就寧可讓他停得掉，
    // 不然麥克風會關不掉，那比誤觸嚴重得多。
    expect(talkButtonAction("recording", null)).toBe("stop");
  });

  it("窮舉：任何狀態都只會回三種動作之一，不會 undefined", () => {
    const states: LiveState[] = [
      "idle",
      "recording",
      "transcribing",
      "thinking",
      "speaking",
      "error",
    ];
    for (const state of states) {
      for (const ms of [null, 0, 499, 500, 30_000]) {
        expect(["start", "stop", "ignore"], `${state} / ${ms}`).toContain(
          talkButtonAction(state, ms)
        );
      }
    }
  });

  it("只有 recording 會回 stop——其他狀態按了不會誤觸送出", () => {
    // 🔴 這條守的是 release() 的 guard：切換式下按到 idle 的按鈕如果跑進
    // release()，recorder.stop() 會回 aborted，畫面就噴一句莫名的
    // 「按住不放，講完再放開」。分派層就不該讓它發生。
    for (const state of ["idle", "transcribing", "thinking", "speaking", "error"] as const) {
      expect(talkButtonAction(state, 3000), state).not.toBe("stop");
    }
  });
});
