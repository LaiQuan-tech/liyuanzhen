import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockDriver } from "./mock";
import type { AvatarDriverHooks } from "./types";

/**
 * 「開頁之後的第一題，她不出聲」的回歸測試。
 *
 * ⚠️ 這是使用者實際回報過三次的 bug（2026-08-19），而且前兩次我都修錯了地方——
 * 先怪空的逐字稿，再怪靜音門檻，兩次都不是原因。真正的原因是時序：
 *
 *   prepare()：/api/avatar-token 0.9 秒 ＋ sessions/start 3.2 秒 ＋ 串流就緒
 *              ＝ 正式站實測 5～8 秒
 *   一輪問答：/api/stt 1.5～2.5 秒 ＋ /api/chat 0.5～3.6 秒 ＝ 2～6 秒
 *
 * 兩者在第一題必然交錯。舊版 `finish()` 開頭寫 `if (!prepared || !session) return;`，
 * 答案就這樣被無聲丟掉——文字出現、她一個字都沒說。第二題之後才正常，
 * 所以任何「連問兩題」的驗收都會漏掉它。
 *
 * 這裡守的是：**連線期間送到的答案要排隊，接通之後補說。**
 */

function makeHooks() {
  const speaking: boolean[] = [];
  const fatal: Error[] = [];
  const hooks: AvatarDriverHooks = {
    onSpeakingChange: (s) => speaking.push(s),
    onFatal: (e) => fatal.push(e),
  };
  return { hooks, speaking, fatal };
}

describe("連線期間送到的答案（mock driver，時序與 heygen 對齊）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("🔴 prepare 還在跑就 finish——接通之後一定要補說出來", async () => {
    const { hooks, speaking } = makeHooks();
    const driver = createMockDriver(hooks);

    const ready = driver.prepare(null);

    // 答案比連線先到（真實世界的第一題就是這樣）
    driver.finish("婦女新知是 1982 年 2 月創刊的。");
    expect(speaking).toEqual([]); // 還沒接通，當然還不能出聲

    await vi.advanceTimersByTimeAsync(1500);
    await ready;

    // ⚠️ 這一行就是整個 bug 的分界：舊版這裡是 []
    expect(speaking).toEqual([true]);
  });

  it("連續兩則只補說最後一則——舊的那則已經沒有意義了", async () => {
    const { hooks, speaking } = makeHooks();
    const driver = createMockDriver(hooks);

    const ready = driver.prepare(null);
    driver.finish("第一則");
    driver.finish("第二則");

    await vi.advanceTimersByTimeAsync(1500);
    await ready;

    expect(speaking).toEqual([true]);
  });

  it("連線期間按下打斷，排隊的那則要丟掉——不可以在接通瞬間才冒出來", async () => {
    const { hooks, speaking } = makeHooks();
    const driver = createMockDriver(hooks);

    const ready = driver.prepare(null);
    driver.finish("一段使用者已經不想聽的答案");
    driver.stop();

    await vi.advanceTimersByTimeAsync(1500);
    await ready;
    await vi.advanceTimersByTimeAsync(10_000);

    // stop() 自己會報一次 false；重點是**沒有** true
    expect(speaking.includes(true)).toBe(false);
  });

  it("連線期間離開頁面，排隊的那則也要丟掉", async () => {
    const { hooks, speaking } = makeHooks();
    const driver = createMockDriver(hooks);

    const ready = driver.prepare(null);
    driver.finish("離開頁面之後不該再出聲");
    await driver.destroy();

    await vi.advanceTimersByTimeAsync(1500);
    await ready;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(speaking).toEqual([]);
  });

  it("從來沒 prepare 過就 finish——沒有東西可以等，安靜忽略", async () => {
    const { hooks, speaking } = makeHooks();
    const driver = createMockDriver(hooks);

    driver.finish("沒有人在等這句話");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(speaking).toEqual([]);
  });
});

/**
 * heygen 本體。mock 的語意對了不代表 heygen 對了——真正上線的是這一支，
 * 所以把 SDK 與兩支端點都假掉，直接驗那條路。
 */
describe("連線期間送到的答案（heygen driver，假 SDK）", () => {
  afterEach(() => {
    vi.doUnmock("@heygen/liveavatar-web-sdk");
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("🔴 sessions/start 還沒回來就 finish——接通之後要用克隆語音補說", async () => {
    const calls: string[] = [];
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });

    const listeners = new Map<string, () => void>();

    class FakeSession {
      readonly mode = "LITE";
      on(event: string, cb: () => void) {
        listeners.set(event, cb);
      }
      once(event: string, cb: () => void) {
        listeners.set(event, cb);
      }
      async start() {
        await startGate;
        // 真的 SDK 在 start() 之後才發串流就緒
        listeners.get("session_stream_ready")?.();
      }
      attach() {
        calls.push("attach");
      }
      interrupt() {
        calls.push("interrupt");
      }
      repeat(text: string) {
        calls.push("repeat:" + text);
      }
      repeatAudio() {
        calls.push("repeatAudio");
      }
      async stop() {}
    }

    vi.resetModules();
    vi.doMock("@heygen/liveavatar-web-sdk", () => ({
      LiveAvatarSession: FakeSession,
      SessionEvent: {
        SESSION_STREAM_READY: "session_stream_ready",
        SESSION_DISCONNECTED: "session_disconnected",
      },
      AgentEventsEnum: {
        AVATAR_SPEAK_STARTED: "avatar_speak_started",
        AVATAR_SPEAK_ENDED: "avatar_speak_ended",
      },
    }));

    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/api/avatar-token")) {
        return new Response(
          JSON.stringify({ sessionToken: "fake-token", maxSessionSeconds: 180 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (String(url).includes("/api/tts")) {
        // 裸 PCM，不足一整塊——會走「最後的殘塊也要送」那條路
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(4096));
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      }
      throw new Error("測試沒有預期到的請求：" + url);
    });

    const { hooks, fatal } = makeHooks();
    const { createHeygenDriver } = await import("./heygen");
    const driver = createHeygenDriver(hooks);

    // prepare 卡在 start()，就像正式站上那 3.2 秒
    const ready = driver.prepare({ muted: true } as unknown as HTMLVideoElement);
    await Promise.resolve();

    driver.finish("婦女新知是 1982 年 2 月創刊的。");
    expect(calls).not.toContain("interrupt"); // 還沒接通，不該碰 session

    releaseStart();
    await ready;
    // 讓 speakWithClonedVoice 的 fetch → 讀串流跑完
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(fatal).toEqual([]);
    // ⚠️ 舊版這裡是 ["attach"]——答案被丟掉，她一個字都沒說
    expect(calls).toContain("interrupt");
    expect(calls).toContain("repeatAudio");

    await driver.destroy();
  });
});

/**
 * TTS 失敗的處理。
 *
 * ⚠️ 這一段是使用者第四次回報「沒反應」之後補的。正式站上 `/api/tts` 出現過 503
 * （同一分鐘用 curl 與瀏覽器直接打都是 200，所以是一次性的平台層失敗），
 * 而當時的程式碼把它吞掉：console 印一行、呼叫 `session.repeat()` 當退路。
 * 實測 `repeat()` 在 LITE 模式是空包彈——指令送得出去，她的聲軌峰值 0.0001，
 * 畫面上也沒有任何說明。訪客得到的就是完全沉默。
 *
 * 所以要守兩件事：一次性失敗要重試救回來；真的救不回來要明講。
 */
describe("TTS 失敗（heygen driver，假 SDK）", () => {
  afterEach(() => {
    vi.doUnmock("@heygen/liveavatar-web-sdk");
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  /** 建一個已經接通的假 heygen driver，並依 `ttsStatuses` 依序回應 /api/tts */
  async function connected(ttsStatuses: number[]) {
    const calls: string[] = [];
    const listeners = new Map<string, () => void>();
    class FakeSession {
      readonly mode = "LITE";
      on(e: string, cb: () => void) { listeners.set(e, cb); }
      once(e: string, cb: () => void) { listeners.set(e, cb); }
      async start() { listeners.get("session_stream_ready")?.(); }
      attach() {}
      interrupt() { calls.push("interrupt"); }
      repeat(t: string) { calls.push("repeat:" + t); }
      repeatAudio() { calls.push("repeatAudio"); }
      async stop() {}
    }
    vi.resetModules();
    vi.doMock("@heygen/liveavatar-web-sdk", () => ({
      LiveAvatarSession: FakeSession,
      SessionEvent: { SESSION_STREAM_READY: "session_stream_ready", SESSION_DISCONNECTED: "session_disconnected" },
      AgentEventsEnum: { AVATAR_SPEAK_STARTED: "avatar_speak_started", AVATAR_SPEAK_ENDED: "avatar_speak_ended" },
    }));

    const ttsHits: number[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/api/avatar-token")) {
        return new Response(JSON.stringify({ sessionToken: "t", maxSessionSeconds: 180 }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url).includes("/api/tts")) {
        const status = ttsStatuses[ttsHits.length] ?? ttsStatuses[ttsStatuses.length - 1];
        ttsHits.push(status);
        if (status !== 200) return new Response(JSON.stringify({ error: "x" }), { status });
        return new Response(
          new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4096)); c.close(); } }),
          { status: 200 }
        );
      }
      throw new Error("沒有預期到的請求：" + url);
    });

    const speaking: boolean[] = [];
    const fatal: Error[] = [];
    let speechFailed = 0;
    const { createHeygenDriver } = await import("./heygen");
    const driver = createHeygenDriver({
      onSpeakingChange: (s) => speaking.push(s),
      onFatal: (e) => fatal.push(e),
      onSpeechFailed: () => { speechFailed += 1; },
    });
    await driver.prepare({} as unknown as HTMLVideoElement);
    return { driver, calls, speaking, fatal, ttsHits, failed: () => speechFailed };
  }

  const settle = () => new Promise((r) => setTimeout(r, 2200));

  it("🔴 一次性的 503 要重試救回來，不可以讓整段回答變成無聲", async () => {
    const c = await connected([503, 503, 200]);
    c.driver.finish("婦女新知是 1982 年 2 月創刊的。");
    await settle();

    expect(c.ttsHits).toEqual([503, 503, 200]);
    expect(c.calls).toContain("repeatAudio"); // 第三次成功，她講出來了
    expect(c.failed()).toBe(0);
    expect(c.fatal).toEqual([]);
    await c.driver.destroy();
  });

  it("🔴 真的救不回來要明講——LITE 的 repeat() 是空包彈，不可以假裝有退路", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = await connected([503]);
    c.driver.finish("這一段發不出聲音");
    await settle();

    expect(c.ttsHits).toHaveLength(3); // 三次都試過了
    expect(c.calls).not.toContain("repeatAudio");
    expect(c.calls.some((x) => x.startsWith("repeat:"))).toBe(false); // LITE 不走這條假退路
    expect(c.failed()).toBe(1); // 有往上報，畫面才有東西可以顯示
    // ⚠️ 一定要自己把「回答中」收掉，不然畫面會無聲地寫著「回答中」20 秒
    expect(c.speaking.at(-1)).toBe(false);
    expect(c.fatal).toEqual([]); // 聲音壞掉不等於整個 driver 死掉，不可以降級
    spy.mockRestore();
    await c.driver.destroy();
  });

  it("4xx 不重試——文字太長送幾次都一樣，白白多等兩秒", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = await connected([400]);
    c.driver.finish("格式不對的請求");
    await settle();

    expect(c.ttsHits).toEqual([400]);
    expect(c.failed()).toBe(1);
    spy.mockRestore();
    await c.driver.destroy();
  });
});
