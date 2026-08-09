import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockDriver } from "./mock";
import { createAvatarDriver, resolveProvider } from "./index";
import type { AvatarDriverHooks } from "./types";

function makeHooks() {
  const speaking: boolean[] = [];
  const fatal: Error[] = [];
  const hooks: AvatarDriverHooks = {
    onSpeakingChange: (s) => speaking.push(s),
    onFatal: (e) => fatal.push(e),
  };
  return { hooks, speaking, fatal };
}

describe("resolveProvider", () => {
  it("預設是 monogram——沒設旗標的人不該意外開始燒錢", () => {
    expect(resolveProvider(undefined)).toBe("monogram");
  });

  it("不認得的值一律回 monogram，不丟例外", () => {
    expect(resolveProvider("typo")).toBe("monogram");
    expect(resolveProvider("")).toBe("monogram");
  });

  it("認得 mock 與 heygen", () => {
    expect(resolveProvider("mock")).toBe("mock");
    expect(resolveProvider("heygen")).toBe("heygen");
  });
});

describe("createAvatarDriver", () => {
  it("⚠️ heygen 還沒實作時要自動降級成 monogram，而不是讓整頁掛掉", async () => {
    const { hooks, fatal } = makeHooks();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const driver = await createAvatarDriver(hooks, "heygen");

    expect(driver.provider).toBe("monogram");
    // 降級不是錯誤：使用者什麼都沒失去，不該把它當 fatal 彈出去
    expect(fatal).toHaveLength(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("mock 就給 mock", async () => {
    const { hooks } = makeHooks();
    expect((await createAvatarDriver(hooks, "mock")).provider).toBe("mock");
  });

  it("monogram 不需要 <video>，mock 需要（要走跟 heygen 同一條路徑）", async () => {
    const { hooks } = makeHooks();
    expect((await createAvatarDriver(hooks, "monogram")).needsVideo).toBe(false);
    expect((await createAvatarDriver(hooks, "mock")).needsVideo).toBe(true);
  });
});

describe("createMockDriver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("prepare 之前不發聲——沒準備好就講話是 heygen 那邊的真實失敗模式", async () => {
    const { hooks, speaking } = makeHooks();
    const driver = createMockDriver(hooks);

    driver.finish("還沒 prepare 就講話");
    expect(speaking).toEqual([]);
  });

  it("⚠️ 串流中的 delta 一律忽略，只有 finish 才開口", async () => {
    const { hooks, speaking } = makeHooks();
    const driver = createMockDriver(hooks);
    const ready = driver.prepare(null);
    await vi.advanceTimersByTimeAsync(1500);
    await ready;

    driver.push("這段");
    driver.push("不該");
    driver.push("出聲");
    expect(speaking).toEqual([]);

    driver.finish("這段不該出聲");
    expect(speaking).toEqual([true]);
  });

  it("講完會自己回報停止——不然頭像會卡在「回答中」", async () => {
    const { hooks, speaking } = makeHooks();
    const driver = createMockDriver(hooks);
    const ready = driver.prepare(null);
    await vi.advanceTimersByTimeAsync(1500);
    await ready;

    driver.finish("四個字");
    expect(speaking).toEqual([true]);

    await vi.advanceTimersByTimeAsync(6000);
    expect(speaking).toEqual([true, false]);
  });

  it("stop() 立刻閉嘴，而且不會有遲到的計時器把 speaking 再打開", async () => {
    const { hooks, speaking } = makeHooks();
    const driver = createMockDriver(hooks);
    const ready = driver.prepare(null);
    await vi.advanceTimersByTimeAsync(1500);
    await ready;

    driver.finish("一段很長的答案".repeat(20));
    driver.stop();
    expect(speaking).toEqual([true, false]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(speaking).toEqual([true, false]);
  });

  it("destroy() 之後完全靜音，且可重複呼叫", async () => {
    const { hooks, speaking } = makeHooks();
    const driver = createMockDriver(hooks);
    const ready = driver.prepare(null);
    await vi.advanceTimersByTimeAsync(1500);
    await ready;

    await driver.destroy();
    await driver.destroy();

    driver.finish("死掉之後不該再出聲");
    driver.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(speaking).toEqual([]);
  });

  it("prepare() 是冪等的——StrictMode 會讓 effect 跑兩次，heygen 那邊等於開兩個計費 session", async () => {
    const { hooks } = makeHooks();
    const driver = createMockDriver(hooks);

    const a = driver.prepare(null);
    const b = driver.prepare(null);
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all([a, b]);

    expect(driver.audioAvailable).toBe(true);
  });

  it("任何方法都不丟例外——數位人壞掉時聊天必須還能用", async () => {
    const { hooks } = makeHooks();
    const driver = createMockDriver(hooks);

    expect(() => driver.push("x")).not.toThrow();
    expect(() => driver.finish("x")).not.toThrow();
    expect(() => driver.stop()).not.toThrow();
    await expect(driver.destroy()).resolves.toBeUndefined();
  });
});
