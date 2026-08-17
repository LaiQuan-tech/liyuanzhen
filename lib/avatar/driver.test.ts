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
  it("⚠️ heygen 模組載入失敗要降級成 monogram，而不是讓整頁掛掉", async () => {
    // 這個測試原本靠「heygen.ts 還不存在」來製造失敗。模組實作出來之後
    // 那個前提消失了，但要守的行為沒變，所以改成明確地把載入弄壞。
    // 真實世界對應的情境：SDK 版本不合、chunk 404、CSP 擋掉。
    const { hooks, fatal } = makeHooks();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.resetModules();
    vi.doMock("./heygen", () => {
      throw new Error("模擬 SDK chunk 載入失敗");
    });

    const { createAvatarDriver: freshCreate } = await import("./index");
    const driver = await freshCreate(hooks, "heygen");

    expect(driver.provider).toBe("monogram");
    // 降級不是錯誤：使用者什麼都沒失去，不該把它當 fatal 彈出去
    expect(fatal).toHaveLength(0);
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
    vi.doUnmock("./heygen");
    vi.resetModules();
  });

  it("heygen 就給 heygen（SDK 只在 prepare 時才載，建構本身不連外）", async () => {
    const { hooks } = makeHooks();
    const driver = await createAvatarDriver(hooks, "heygen");

    expect(driver.provider).toBe("heygen");
    expect(driver.needsVideo).toBe(true);
    expect(driver.metered).toBe(true);
    // prepare 之前不該宣稱自己出得了聲
    expect(driver.audioAvailable).toBe(false);
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

describe("createHeygenDriver", () => {
  it("⚠️ 沒有 <video> 就 onFatal，不可以開 session——開了也沒地方畫，純燒錢", async () => {
    const { hooks, fatal } = makeHooks();
    const driver = await createAvatarDriver(hooks, "heygen");

    await driver.prepare(null);

    expect(fatal).toHaveLength(1);
    expect(driver.audioAvailable).toBe(false);
  });

  it("prepare 沒成功之前，finish／stop 都要靜靜地不做事（不能丟例外）", async () => {
    const { hooks, speaking } = makeHooks();
    const driver = await createAvatarDriver(hooks, "heygen");

    expect(() => driver.finish("婦女新知是怎麼開始的？")).not.toThrow();
    expect(() => driver.stop()).not.toThrow();
    driver.push("串流中的片段");

    // 沒有 session 就不該回報任何說話狀態，否則 UI 會卡在「回答中」
    expect(speaking).toEqual([]);
  });

  it("destroy 可以重複呼叫（切分頁＋離開頁面會各觸發一次）", async () => {
    const { hooks } = makeHooks();
    const driver = await createAvatarDriver(hooks, "heygen");

    await expect(driver.destroy()).resolves.toBeUndefined();
    await expect(driver.destroy()).resolves.toBeUndefined();
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
