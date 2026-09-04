import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_POSES,
  POSE_SEATED,
  POSE_STANDING,
  POSE_STANDING_STAGE,
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

  it("滿版背景板站姿（/live3）的數字", () => {
    expect(POSE_STANDING_STAGE).toEqual({
      src: "/avatar-fullbody-standing-cutout.webp",
      poster: "/avatar-poster-stage.jpg",
      box: { left: "7.37%", top: "0.55%", width: "84.31%", height: "26.67%" },
      background: "/live-bg-stage.webp",
    });
  });

  /**
   * 🔴 滿版版的去背檔是從站姿那張 JPEG 逐像素做出來的，所以幾何必須完全相同。
   * poses.ts 寫的是引用（`box: POSE_STANDING.box`），但引用會被後人「順手展開
   * 成字面量」，展開之後就可能只改一邊。這條在守那個。
   * 壞掉的樣子很難查：兩頁共用同一組數字，所以看起來會像幾何算錯，
   * 其實是有人動了其中一份。
   */
  it("🔴 滿版版與站姿版必須是同一組幾何", () => {
    expect(POSE_STANDING_STAGE.box).toEqual(POSE_STANDING.box);
    expect(POSE_STANDING_STAGE.poster).toBe(POSE_STANDING.poster);
  });

  /**
   * ⚠️ 這條與下面兩條都吃 ALL_POSES，不要改回寫死列舉。
   * 原本是手動列兩個姿勢的迴圈，加第三個的時候很容易忘記擴充，
   * 新姿勢就完全沒被驗到。
   */
  it("每個姿勢的影片框都要是 16:9，不然臉會被拉扁", () => {
    // 舞台框固定 9:16（1080×1920），所以 box 的百分比換算回像素之後
    // 寬高比必須是 16/9。這是整套對位的前提，算錯就整個歪掉。
    for (const pose of ALL_POSES) {
      const w = (parseFloat(pose.box.width) / 100) * 1080;
      const h = (parseFloat(pose.box.height) / 100) * 1920;
      expect(w / h, pose.src).toBeCloseTo(16 / 9, 2);
    }
  });

  it("所有姿勢共用同一組遮罩", () => {
    // 橢圓與影片框都是照「底圖裡的頭有多高」推的，比例是不變量。
    // 哪天有人把它複製成兩份，這一條會提醒他不需要。
    expect(STAGE_MASK).toContain("radial-gradient(ellipse");
    expect(STAGE_MASK).toContain("50.78%");
  });

  it("每個姿勢的底圖都不一樣", () => {
    const srcs = ALL_POSES.map((p) => p.src);
    expect(new Set(srcs).size).toBe(srcs.length);
  });

  /**
   * 🔴 有背景圖就代表底圖是去背檔，兩者是一組。
   * 只換一邊的後果：給了背景卻用不透明 JPEG → 背景板中間一張灰色長方形；
   * 給了去背檔卻沒有背景 → 她浮在 #1A1A1A 上。
   * WebP／PNG 是目前 repo 裡唯二帶 alpha 的格式。
   */
  it("有背景的姿勢，底圖必須是帶 alpha 的格式", () => {
    for (const pose of ALL_POSES) {
      if (!pose.background) continue;
      expect(pose.src, pose.src).toMatch(/\.(webp|png)$/);
    }
  });

  /**
   * ⚠️ 這條抓的是最可能發生的上線事故：素材改名或忘了 commit，
   * 頁面出 404，人物或背景整個不見。前面那些百分比再正確也沒用。
   */
  it("每個姿勢引用的素材都要真的存在於 public/", () => {
    for (const pose of ALL_POSES) {
      for (const asset of [pose.src, pose.poster, pose.background]) {
        if (!asset) continue;
        expect(existsSync(join(process.cwd(), "public", asset)), asset).toBe(true);
      }
    }
  });
});
