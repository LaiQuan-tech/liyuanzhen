import { describe, it, expect, vi } from "vitest";
import {
  TTS_ATTEMPTS,
  TTS_ENDPOINT,
  fetchTtsStream,
  isRetryableTtsStatus,
  ttsRetryDelayMs,
} from "./tts-request";

/**
 * `/api/tts` 的重試策略。heygen driver（/live 系列）與 monogram driver（/chat 朗讀、
 * 語音頁備援）共用這一份，所以這裡鎖的就是兩邊的規格：
 * 3 次、間隔 400ms / 800ms、4xx 不重試但 429 例外、連線失敗也重試、被打斷不算失敗。
 */

/** 只實作 fetchTtsStream 會碰到的那幾個欄位 */
function reply(status: number, body: ReadableStream<Uint8Array> | null = null): Response {
  const cancel = vi.fn(() => Promise.resolve());
  return {
    ok: status >= 200 && status < 300,
    status,
    body: body ?? (status >= 200 && status < 300 ? null : ({ cancel } as unknown as ReadableStream<Uint8Array>)),
  } as unknown as Response;
}

function pcm(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      controller.close();
    },
  });
}

/** 依序回應的假 fetch；每一次呼叫的參數都記下來，step 拿得到真正傳進來的 init（含 signal） */
function scripted(steps: Array<(init: RequestInit) => Promise<Response>>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = steps[calls.length - 1];
    if (!step) throw new Error(`第 ${calls.length} 次呼叫沒有安排回應`);
    return step(init ?? {});
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** 不真的等，只記下要等多久 */
function recordingSleep() {
  const waits: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    waits.push(ms);
  });
  return { sleep, waits };
}

describe("isRetryableTtsStatus", () => {
  it("4xx 不重試——文字太長、格式不對，送幾次都一樣", () => {
    for (const status of [400, 401, 403, 404, 413, 422]) {
      expect(isRetryableTtsStatus(status)).toBe(false);
    }
  });

  it("⚠️ 429 例外：那是「太快了」，等一下就好", () => {
    expect(isRetryableTtsStatus(429)).toBe(true);
  });

  it("5xx 重試：正式站出現過平台層的一次性 503", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isRetryableTtsStatus(status)).toBe(true);
    }
  });
});

describe("ttsRetryDelayMs", () => {
  it("間隔是 400ms、800ms（乘上第幾次）", () => {
    expect(ttsRetryDelayMs(1)).toBe(400);
    expect(ttsRetryDelayMs(2)).toBe(800);
  });
});

describe("fetchTtsStream", () => {
  it("第一次就成功：只打一次，body 原封不動交回去（還沒讀），請求形狀跟 route 一致", async () => {
    const body = pcm();
    const { fetchImpl, calls } = scripted([async () => reply(200, body)]);
    const { sleep } = recordingSleep();

    const result = await fetchTtsStream("婦女新知是怎麼開始的？", { fetchImpl, sleep });

    expect(result).toBe(body);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TTS_ENDPOINT);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ text: "婦女新知是怎麼開始的？" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("503、503 之後成功：總共 3 次，中間等 400ms、800ms", async () => {
    const body = pcm();
    const { fetchImpl, calls } = scripted([
      async () => reply(503),
      async () => reply(503),
      async () => reply(200, body),
    ]);
    const { sleep, waits } = recordingSleep();

    await expect(fetchTtsStream("x", { fetchImpl, sleep })).resolves.toBe(body);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([400, 800]);
  });

  it("重試用盡：丟出最後一次的原因，最後一次失敗之後不再空等", async () => {
    const { fetchImpl, calls } = scripted([
      async () => reply(502),
      async () => reply(502),
      async () => reply(502),
    ]);
    const { sleep, waits } = recordingSleep();

    await expect(fetchTtsStream("x", { fetchImpl, sleep })).rejects.toThrow("TTS 502");
    expect(calls).toHaveLength(TTS_ATTEMPTS);
    expect(waits).toEqual([400, 800]);
  });

  it("400 不重試：打一次就放棄", async () => {
    const { fetchImpl, calls } = scripted([async () => reply(400)]);
    const { sleep } = recordingSleep();

    await expect(fetchTtsStream("x", { fetchImpl, sleep })).rejects.toThrow("TTS 400");
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("429 會重試", async () => {
    const body = pcm();
    const { fetchImpl, calls } = scripted([async () => reply(429), async () => reply(200, body)]);
    const { sleep, waits } = recordingSleep();

    await expect(fetchTtsStream("x", { fetchImpl, sleep })).resolves.toBe(body);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([400]);
  });

  it("連線失敗（fetch 丟例外）也重試，用盡時訊息寫明是連線失敗", async () => {
    const { fetchImpl, calls } = scripted([
      async () => Promise.reject(new TypeError("Failed to fetch")),
      async () => Promise.reject(new TypeError("Failed to fetch")),
      async () => Promise.reject(new TypeError("Failed to fetch")),
    ]);
    const { sleep } = recordingSleep();

    await expect(fetchTtsStream("x", { fetchImpl, sleep })).rejects.toThrow(
      "連線失敗：Failed to fetch"
    );
    expect(calls).toHaveLength(3);
  });

  it("isCancelled（heygen 的 destroy 之後）就不再等下一次重試", async () => {
    const { fetchImpl, calls } = scripted([async () => reply(503)]);
    const { sleep } = recordingSleep();

    await expect(
      fetchTtsStream("x", { fetchImpl, sleep, isCancelled: () => true })
    ).rejects.toThrow("TTS 503");
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("signal 已經 abort：一次都不打，丟 AbortError", async () => {
    const { fetchImpl, calls } = scripted([]);
    const controller = new AbortController();
    controller.abort();

    await expect(fetchTtsStream("x", { fetchImpl, signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(calls).toHaveLength(0);
  });

  it("⚠️ 請求在飛的時候被打斷：signal 真的有交給 fetch、丟 AbortError、不重試——被打斷不是失敗", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = scripted([
      // ⚠️ 要聽「傳進 fetch 的那個 signal」，不是測試自己的 controller——
      // 否則 fetchTtsStream 忘了把 signal 交給 fetch，這條照樣會過
      (init) =>
        new Promise<Response>((_, reject) => {
          if (!init.signal) return reject(new Error("signal 沒有交給 fetch"));
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError"))
          );
        }),
    ]);
    const { sleep } = recordingSleep();

    const pending = fetchTtsStream("x", { fetchImpl, sleep, signal: controller.signal });
    // 交給 fetch 的必須就是這一個 signal——少了它，打斷時還在飛的合成不會被取消
    expect(calls[0].init.signal).toBe(controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("重試的空檔被打斷：立刻醒來、不再送下一次（預設的 sleep 要聽 signal）", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const { fetchImpl, calls } = scripted([async () => reply(503)]);

      const pending = fetchTtsStream("x", { fetchImpl, signal: controller.signal });
      const settled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(100); // 還在等 400ms 的第一個空檔
      controller.abort();
      await settled;

      expect(calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0); // 空檔的計時器也要收掉
    } finally {
      vi.useRealTimers();
    }
  });

  it("失敗回應的 body 要放掉，不要讓連線掛著", async () => {
    const failed = reply(400);
    const { fetchImpl } = scripted([async () => failed]);

    await expect(fetchTtsStream("x", { fetchImpl })).rejects.toThrow("TTS 400");
    expect((failed.body as unknown as { cancel: ReturnType<typeof vi.fn> }).cancel).toHaveBeenCalled();
  });
});
