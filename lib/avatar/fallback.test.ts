import { describe, it, expect } from "vitest";
import { isCurrentDriver, nextDriverProvider, shouldHandleFatal } from "./fallback";
import { createAvatarDriver } from "./index";
import type { AvatarDriver, AvatarDriverHooks, AvatarProvider } from "./types";

/**
 * AvatarStage 降級的判斷（元件本身在 node 測不到，判斷抽到 lib/avatar/fallback.ts）。
 *
 * 🔴 鎖住 2026-09-29 的決定：執行期 onFatal 之後，這個 mount 內**永遠不再建 heygen**。
 * 舊版 onFatal 只切畫面，下一次按說話 ensureDriver() 照 providerOverride 重建 heygen——
 * 撞上「沒有 <video> 就不開 session」的護欄，那一題無聲又沒有提示，再下一次才又去鑄 token。
 */

const hooks: AvatarDriverHooks = { onSpeakingChange: () => {}, onFatal: () => {} };
const REQUESTS: (AvatarProvider | undefined)[] = ["heygen", "mock", "monogram", undefined];

/** 只拿來比身分，用不到任何方法 */
const fakeDriver = (name: string) => ({ provider: name }) as unknown as AvatarDriver;

describe("nextDriverProvider", () => {
  it("🔴 降級過：不管頁面指定什麼（/live 指定的是 heygen），一律 monogram", () => {
    for (const requested of REQUESTS) {
      expect(nextDriverProvider(requested, true)).toBe("monogram");
    }
  });

  it("沒降級：照頁面指定的（沒指定就是 undefined，交給 resolveProvider）——teardown 之後照舊重建 heygen", () => {
    for (const requested of REQUESTS) {
      expect(nextDriverProvider(requested, false)).toBe(requested);
    }
  });

  it("🔴 降級過之後真的建出來的 driver 是 monogram，不是 heygen（不需要 <video>、不計費）", async () => {
    for (const requested of REQUESTS) {
      const driver = await createAvatarDriver(hooks, nextDriverProvider(requested, true));
      expect(driver.provider).toBe("monogram");
      expect(driver.needsVideo).toBe(false);
      expect(driver.metered).toBe(false);
      await driver.destroy();
    }
  });
});

describe("shouldHandleFatal", () => {
  const heygen = fakeDriver("heygen");
  const monogram = fakeDriver("monogram");

  it("目前拿著的 driver 回報 → 處理", () => {
    expect(shouldHandleFatal({ unmounted: false, current: heygen }, heygen)).toBe(true);
  });

  it("🔴 過期的回報（driverRef 已經換成降級用的 monogram）→ 忽略，不可以把新的 monogram 收掉", () => {
    expect(shouldHandleFatal({ unmounted: false, current: monogram }, heygen)).toBe(false);
  });

  it("driverRef 已經清空（teardown 之後、降級之後 monogram 還沒建好）→ 忽略", () => {
    expect(shouldHandleFatal({ unmounted: false, current: null }, heygen)).toBe(false);
  });

  it("已卸載 → 忽略", () => {
    expect(shouldHandleFatal({ unmounted: true, current: heygen }, heygen)).toBe(false);
  });

  it("不知道是誰在報（hooks 比 driver 先建）→ 忽略", () => {
    expect(shouldHandleFatal({ unmounted: false, current: null }, null)).toBe(false);
  });
});

describe("isCurrentDriver（AvatarStage.prepare 在 await driver.prepare() 回來之後問的那一句）", () => {
  const heygen = fakeDriver("heygen");

  it("還是同一個 → 繼續開畫面、開閒置與上限計時器", () => {
    expect(isCurrentDriver({ unmounted: false, current: heygen }, heygen)).toBe(true);
  });

  it("🔴 等待期間被換掉（fatal 降級）、被收掉（teardown）或卸載 → 什麼都不要碰，不然就是孤兒計時器", () => {
    expect(isCurrentDriver({ unmounted: false, current: fakeDriver("monogram") }, heygen)).toBe(false);
    expect(isCurrentDriver({ unmounted: false, current: null }, heygen)).toBe(false);
    expect(isCurrentDriver({ unmounted: true, current: heygen }, heygen)).toBe(false);
  });
});
