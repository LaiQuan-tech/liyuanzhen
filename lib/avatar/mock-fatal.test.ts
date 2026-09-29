import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockDriver, readMockFatal } from "./mock";
import type { AvatarDriverHooks } from "./types";

/**
 * mock driver 的故障注入（`?mockFatal=prepare|speak`），給本機瀏覽器驗證執行期 onFatal 的降級用。
 *
 * 🔴 mock 存在的意義是「時序與語意跟 heygen 一樣」——不一樣的話 CI 會蓋掉 heygen 上真實的 bug。
 * 所以 fatal 的語意鎖成跟 heygen.test.ts 的 B 組同一套：每個 driver 最多報一次、destroy 之後不報、
 * 手上還沒送達的答案先 onSpeechFailed 一次（順序：說話狀態收掉 → onSpeechFailed → onFatal）。
 * ⚠️ 沒帶參數時行為完全不變（既有的 driver.test.ts／speak-queue.test.ts 鎖著）。
 */

function makeHooks() {
  const log: string[] = [];
  const hooks: AvatarDriverHooks = {
    onSpeakingChange: (s) => log.push("speaking:" + s),
    onFatal: (e) => log.push("fatal:" + e.message),
    onSpeechFailed: () => log.push("speechFailed"),
  };
  const count = (entry: string) => log.filter((x) => x === entry || x.startsWith(entry + ":")).length;
  return { hooks, log, count };
}

/** 模擬瀏覽器網址。node 環境沒有 window，不 stub 就是「沒帶參數」 */
function atUrl(search: string) {
  vi.stubGlobal("window", { location: { search } });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("readMockFatal", () => {
  it("認得 prepare 與 speak，其他一律當沒帶", () => {
    expect(readMockFatal("?mockFatal=prepare")).toBe("prepare");
    expect(readMockFatal("?mockFatal=speak")).toBe("speak");
    expect(readMockFatal("?debug=1&mockFatal=speak")).toBe("speak");
    expect(readMockFatal("?mockFatal=disconnect")).toBeNull();
    expect(readMockFatal("?debug=1")).toBeNull();
    expect(readMockFatal("")).toBeNull();
    expect(readMockFatal(undefined)).toBeNull();
  });
});

describe("沒帶參數：行為完全不變", () => {
  it("node 環境（沒有 window）：接得通、講得完、永遠不會 onFatal", async () => {
    const { hooks, log } = makeHooks();
    const driver = createMockDriver(hooks);
    const ready = driver.prepare(null);
    await vi.advanceTimersByTimeAsync(1500);
    await ready;

    driver.finish("一段二十個字左右的答案，講完就停。");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(log).toEqual(["speaking:true", "speaking:false"]);
    expect(driver.audioAvailable).toBe(true);
  });

  it("網址帶了別的參數（?debug=1）或看不懂的值：一樣不注入", async () => {
    for (const search of ["?debug=1", "?mockFatal=boom"]) {
      atUrl(search);
      const { hooks, log } = makeHooks();
      const driver = createMockDriver(hooks);
      const ready = driver.prepare(null);
      await vi.advanceTimersByTimeAsync(1500);
      await ready;
      driver.finish("講完就停。");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(log).toEqual(["speaking:true", "speaking:false"]);
    }
  });
});

describe("?mockFatal=prepare：接通失敗", () => {
  it("🔴 連線期間有答案在排隊：speechFailed×1 → fatal×1，排隊的那則不會開口", async () => {
    atUrl("?mockFatal=prepare");
    const { hooks, log } = makeHooks();
    const driver = createMockDriver(hooks);

    const ready = driver.prepare(null);
    driver.finish("連線期間到的答案");
    await vi.advanceTimersByTimeAsync(1500);
    await ready;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(log).toEqual(["speechFailed", "fatal:mockFatal=prepare：模擬接通失敗"]);
    expect(driver.audioAvailable).toBe(false);
  });

  it("沒有答案在排隊：只有 fatal；報過之後 finish 明講沒聲音、prepare 不會再報第二次", async () => {
    atUrl("?mockFatal=prepare");
    const { hooks, log, count } = makeHooks();
    const driver = createMockDriver(hooks);

    const ready = driver.prepare(null);
    await vi.advanceTimersByTimeAsync(1500);
    await ready;
    expect(log).toEqual(["fatal:mockFatal=prepare：模擬接通失敗"]);

    driver.finish("斷線之後才到的答案");
    const again = driver.prepare(null);
    await vi.advanceTimersByTimeAsync(1500);
    await again;

    expect(count("fatal")).toBe(1);
    expect(count("speechFailed")).toBe(1);
    expect(log).not.toContain("speaking:true");
  });

  it("destroy 之後才到失敗的時間點：什麼都不報", async () => {
    atUrl("?mockFatal=prepare");
    const { hooks, log } = makeHooks();
    const driver = createMockDriver(hooks);

    const ready = driver.prepare(null);
    driver.finish("排隊的答案");
    await driver.destroy();
    await vi.advanceTimersByTimeAsync(1500);
    await ready;

    expect(log).toEqual([]);
  });
});

describe("?mockFatal=speak：第一則答案講到一半斷線", () => {
  async function prepared() {
    atUrl("?mockFatal=speak");
    const h = makeHooks();
    const driver = createMockDriver(h.hooks);
    const ready = driver.prepare(null);
    await vi.advanceTimersByTimeAsync(1500);
    await ready;
    return { driver, ...h };
  }

  it("🔴 講到一半斷線：說話狀態收掉 → speechFailed×1 → fatal×1，之後什麼都不再報", async () => {
    const { driver, log } = await prepared();

    driver.finish("一二三四五六七八"); // 8 字 × 250ms ＝ 2 秒，斷線落在第 1 秒
    expect(log).toEqual(["speaking:true"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(log).toEqual(["speaking:true"]);
    await vi.advanceTimersByTimeAsync(1);

    expect(log).toEqual([
      "speaking:true",
      "speaking:false",
      "speechFailed",
      "fatal:mockFatal=speak：模擬說話中斷線",
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log).toHaveLength(4);
  });

  it("報過 fatal、還沒被收掉：下一則明講沒聲音，不會開口", async () => {
    const { driver, log, count } = await prepared();
    driver.finish("一二三四五六七八");
    await vi.advanceTimersByTimeAsync(1_000);

    driver.finish("斷線之後才到的答案");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(count("speechFailed")).toBe(2);
    expect(count("fatal")).toBe(1);
    expect(log.filter((x) => x === "speaking:true")).toHaveLength(1);
  });

  it("斷線之前就被 stop() 打斷：斷線時只有 fatal（被打斷的那則不算沒送達）", async () => {
    const { driver, log } = await prepared();
    driver.finish("一二三四五六七八");
    driver.stop();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(log).toEqual(["speaking:true", "speaking:false", "fatal:mockFatal=speak：模擬說話中斷線"]);
  });

  it("斷線之前就 destroy：什麼都不報", async () => {
    const { driver, log } = await prepared();
    driver.finish("一二三四五六七八");
    await driver.destroy();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(log).toEqual(["speaking:true"]);
  });

  it("只斷第一則：沒斷線前，連線期間排隊的那則補說時也算「第一則」", async () => {
    atUrl("?mockFatal=speak");
    const { hooks, log } = makeHooks();
    const driver = createMockDriver(hooks);
    const ready = driver.prepare(null);
    driver.finish("一二三四五六七八");
    await vi.advanceTimersByTimeAsync(1200); // 接通 → 補說排隊的那則
    await ready;
    expect(log).toEqual(["speaking:true"]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(log).toEqual([
      "speaking:true",
      "speaking:false",
      "speechFailed",
      "fatal:mockFatal=speak：模擬說話中斷線",
    ]);
  });
});
