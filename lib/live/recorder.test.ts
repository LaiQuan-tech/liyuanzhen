import { describe, it, expect } from "vitest";
import { classifyRecording, MIN_RECORDING_SECONDS } from "./recorder";

/**
 * 「按住講了話，畫面卻回你按太快」的回歸測試。
 *
 * ⚠️ 這是 2026-08-20 凌晨那次回報的直接成因。使用者按住約 1 秒、
 * 音量計整排全平，放開之後得到「按住不放，講完再放開。」
 *
 * 舊版把「誤觸」與「收音管線死掉」塌成同一個 null，呼叫端沒有任何辦法分辨——
 * 而這兩件事對使用者的意義完全相反：一個要他再按一次，另一個要他重新整理。
 *
 * ⚠️ 換成 MediaRecorder 之後判斷依據換了，但**分界本身不能鬆**：
 * 不再數 worklet 送了幾塊，改看位元組數，並且多了一個更準的信號——
 * `MediaStreamTrack.muted`，它的語意就是「這條軌現在沒有在提供資料」。
 */
describe("classifyRecording", () => {
  it("正常錄到就是 ok", () => {
    expect(
      classifyRecording({ bytes: 9_400, heldMs: 3_070, seconds: 3.07, trackMuted: false })
    ).toBe("ok");
  });

  it("點一下就放（幾乎沒有位元組、按住很短）＝ 誤觸，安靜帶過", () => {
    expect(
      classifyRecording({ bytes: 320, heldMs: 80, seconds: 0.08, trackMuted: false })
    ).toBe("too-short");
  });

  it("🔴 按住一秒卻只有標頭 ＝ 收音壞了，不可以說成誤觸", () => {
    expect(
      classifyRecording({ bytes: 320, heldMs: 1_000, seconds: 1, trackMuted: false })
    ).toBe("no-audio");
  });

  it("🔴 音軌自己說 muted，就是 no-audio——不管錄到多少位元組", () => {
    // MediaStreamTrack.muted ＝「這條軌沒有在提供資料」（被別的程式佔用、
    // 系統層靜音、裝置拔掉）。這是舊的 AudioWorklet 路徑拿不到的信號，
    // 也是那時候只能靠「零塊 ＋ 按住多久」去猜的原因。
    expect(
      classifyRecording({ bytes: 9_400, heldMs: 3_000, seconds: 3, trackMuted: true })
    ).toBe("no-audio");
  });

  it("有錄到、但不足下限 ＝ 誤觸（不是收音壞了）", () => {
    expect(
      classifyRecording({
        bytes: 1_200,
        heldMs: 120,
        seconds: MIN_RECORDING_SECONDS / 2,
        trackMuted: false,
      })
    ).toBe("too-short");
  });

  it("剛好踩在下限上算 ok，不要把邊界丟掉", () => {
    expect(
      classifyRecording({
        bytes: 1_500,
        heldMs: 200,
        seconds: MIN_RECORDING_SECONDS,
        trackMuted: false,
      })
    ).toBe("ok");
  });

  it("⚠️ 分界不看音量——音量是 SILENCE_RMS 的事，而且它有可能是「不知道」", () => {
    // 錄到一大段但全是靜音，仍然是 ok。要不要提醒使用者由呼叫端用 peak 判斷，
    // 而 peak 是 null 時必須放行。兩件事合併過一次，症狀是使用者正常講話
    // 卻被回「沒有收到聲音」。
    expect(
      classifyRecording({ bytes: 10_200, heldMs: 3_400, seconds: 3.4, trackMuted: false })
    ).toBe("ok");
  });
});
