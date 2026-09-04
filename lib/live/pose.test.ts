import { describe, it, expect } from "vitest";
import {
  POSE_SEATED,
  POSE_STANDING,
  STAGE_MASK,
} from "@/components/avatar/poses";

/**
 * 姿勢幾何的回歸測試。
 *
 * 🔴 存在的理由很具體：這些百分比**沒有任何其他東西在守**。
 * 專案的 vitest 是 node 環境、`include` 只吃 `*.test.ts`，沒有 jsdom 也沒有
 * React Testing Library，所以 `components/avatar/*` 一行都測不到。打錯一個
 * 百分比只有肉眼看得出來，而症狀（頭位移幾 px、脖子多一道邊、頭髮一圈光暈）
 * 正是 full-body-stage.tsx 檔頭記錄的那幾種、debug 過很多輪的問題。
 *
 * 這一支不驗「好不好看」——那要看圖。它驗的是**加新姿勢的時候，舊姿勢的
 * 數字有沒有被順手改掉**。/live 已經上線並且對過位，它的四個值就是憲法。
 */
describe("姿勢幾何", () => {
  it("🔴 坐姿（/live 正在用）的數字不可以變", () => {
    expect(POSE_SEATED).toEqual({
      src: "/avatar-fullbody.jpg",
      poster: "/avatar-poster-stage.jpg",
      box: { left: "7.01%", top: "0.86%", width: "84.85%", height: "26.85%" },
    });
  });

  it("站姿（/live2）的數字", () => {
    expect(POSE_STANDING).toEqual({
      src: "/avatar-fullbody-standing.jpg",
      poster: "/avatar-poster-stage.jpg",
      box: { left: "7.37%", top: "0.55%", width: "84.31%", height: "26.67%" },
    });
  });

  it("兩個姿勢的影片框都要是 16:9，不然臉會被拉扁", () => {
    // 舞台框固定 9:16（1080×1920），所以 box 的百分比換算回像素之後
    // 寬高比必須是 16/9。這是整套對位的前提，算錯就整個歪掉。
    for (const [name, pose] of [
      ["seated", POSE_SEATED],
      ["standing", POSE_STANDING],
    ] as const) {
      const w = parseFloat(pose.box.width) / 100 * 1080;
      const h = parseFloat(pose.box.height) / 100 * 1920;
      expect(w / h, name).toBeCloseTo(16 / 9, 2);
    }
  });

  it("兩個姿勢共用同一組遮罩", () => {
    // 橢圓與影片框都是照「底圖裡的頭有多高」推的，比例是不變量。
    // 哪天有人把它複製成兩份，這一條會提醒他不需要。
    expect(STAGE_MASK).toContain("radial-gradient(ellipse");
    expect(STAGE_MASK).toContain("50.78%");
  });

  it("兩個姿勢的底圖不可以是同一張", () => {
    expect(POSE_STANDING.src).not.toBe(POSE_SEATED.src);
  });
});
