import { describe, it, expect } from "vitest";
import { classifyRecording, MIN_RECORDING_SECONDS } from "./recorder";

/**
 * 「按住講了話，畫面卻回你按太快」的回歸測試。
 *
 * ⚠️ 這是 2026-08-20 凌晨那次回報的直接成因。使用者按住約 1 秒、
 * 音量計整排全平，放開之後得到「按住不放，講完再放開。」
 *
 * 真相是 worklet 一塊音訊都沒送出來（`total` 是 0 → `seconds` 是 0），
 * 於是撞上「太短」那條分支。舊版把「誤觸」與「錄音管線死掉」塌成同一個 null，
 * 呼叫端沒有任何辦法分辨——而這兩件事對使用者的意義完全相反：
 * 一個要他再按一次，另一個要他重新整理。
 */
describe("classifyRecording", () => {
  it("正常錄到就是 ok", () => {
    expect(classifyRecording({ chunkCount: 36, heldMs: 3070, seconds: 3.07 })).toBe("ok");
  });

  it("點一下就放（零塊、按住很短）＝ 誤觸，安靜帶過", () => {
    expect(classifyRecording({ chunkCount: 0, heldMs: 80, seconds: 0 })).toBe("too-short");
  });

  it("🔴 按住一秒卻零塊 ＝ 管線死掉，不可以說成誤觸", () => {
    // 這一組數字就是使用者錄影裡的實況
    expect(classifyRecording({ chunkCount: 0, heldMs: 1000, seconds: 0 })).toBe("no-audio");
  });

  it("🔴 按住三秒半卻零塊，一樣是管線死掉", () => {
    expect(classifyRecording({ chunkCount: 0, heldMs: 3500, seconds: 0 })).toBe("no-audio");
  });

  it("有收到塊、但取樣不足下限 ＝ 誤觸（不是管線死掉）", () => {
    // 收得到塊代表 worklet 活著，那就是真的按太快
    expect(
      classifyRecording({ chunkCount: 1, heldMs: 1200, seconds: MIN_RECORDING_SECONDS / 2 })
    ).toBe("too-short");
  });

  it("剛好踩在下限上算 ok，不要把邊界丟掉", () => {
    expect(
      classifyRecording({ chunkCount: 3, heldMs: 400, seconds: MIN_RECORDING_SECONDS })
    ).toBe("ok");
  });

  it("⚠️ 分界只看「有沒有收到塊」，不看音量——音量是 SILENCE_RMS 的事", () => {
    // 收到一堆塊但全是靜音，仍然是 ok；要不要提醒使用者由呼叫端用 peak 判斷。
    // 這兩件事合併過一次，症狀是使用者正常講話卻被回「沒有收到聲音」。
    expect(classifyRecording({ chunkCount: 40, heldMs: 3400, seconds: 3.4 })).toBe("ok");
  });
});
