/**
 * 前端打 `/api/tts` 的唯一一條路。
 *
 * heygen driver（/live、/live2、/live3）、monogram driver（/chat 的朗讀、語音頁的備援）
 * 與 /live4 的 ChibiStage 都走這裡。🔴 抽出來的理由是重試策略只能有一份：各寫一套的話，
 * 總有一天會出現「/live 會重試、/chat 不會」這種只在正式站偶發失敗時才看得到的差別。
 *
 * ⚠️ /live4 以前自己直接 fetch、不重試（2026-09-29 起改走 lib/avatar/speech-stream.ts，
 * 那支再呼叫這裡）——那段期間一次性的 503 在 /live4 就是整段無聲，在 /live 卻救得回來。
 * heygen 與 /live4 經 speech-stream.ts 進來（先切段），monogram 自己切段後直接呼叫這裡。
 */

/** 合成端點。回**串流的裸 PCM**（16-bit / 24kHz / 單聲道），不是 JSON。 */
export const TTS_ENDPOINT = "/api/tts";

/** 最多送幾次。見 fetchTtsStream 的說明。 */
export const TTS_ATTEMPTS = 3;
/** 重試間隔，會乘上第幾次（400ms、800ms）。 */
export const TTS_RETRY_MS = 400;

/**
 * 這個 HTTP 狀態碼值不值得再送一次。
 *
 * ⚠️ 4xx **不重試**——文字太長、格式不對這種錯，送幾次都一樣。
 * 只有 429 例外，那是「太快了」，等一下就好。
 *
 * 5xx 一律重試：正式站上 `/api/tts` 出現過 503，而 503 在這支路由只可能來自平台層
 * （我們自己的 not_configured 分支不會忽然成立，同一分鐘用 curl 與瀏覽器打都是 200）。
 * 那種一次性失敗以前會直接讓整段回答變成無聲。
 */
export function isRetryableTtsStatus(status: number): boolean {
  if (status === 429) return true;
  return !(status >= 400 && status < 500);
}

/** 第 `attempt` 次（從 1 起算）失敗之後，要等多久才送下一次 */
export function ttsRetryDelayMs(attempt: number): number {
  return TTS_RETRY_MS * attempt;
}

export interface FetchTtsOptions {
  /**
   * 打斷用（關閉朗讀、送出新問題、元件卸載）。
   * abort 之後不再重試，直接把 AbortError 丟出去——被打斷不是失敗，呼叫端不該報錯。
   */
  signal?: AbortSignal;
  /** 呼叫端已經死了（heygen 的 destroy 之後）就不要再等下一次重試 */
  isCancelled?: () => boolean;
  /** 測試用：換掉 fetch */
  fetchImpl?: typeof fetch;
  /** 測試用：換掉重試之間的等待 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("已取消", "AbortError");
}

/**
 * 等 ms 毫秒；中途被 abort 就提早醒來（醒來之後由呼叫端自己決定要丟 AbortError 還是直接收手）。
 * speech-stream.ts 的「後段失敗等她唸完才回報」也用它：那段等待被打斷時要立刻醒來、不回報。
 */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * 取 TTS 串流，失敗會重試：最多 TTS_ATTEMPTS 次，間隔 400ms、800ms；
 * 4xx 不重試（429 例外）；連線失敗（fetch 丟例外）也重試。
 *
 * 回傳的是 response.body，**還沒讀**。⚠️ 呼叫端要邊收邊播，不要先收成完整 buffer——
 * 那會把首字延遲從 3.6 秒變成 12.9 秒（見 lib/avatar/lipsync-player.ts 檔頭）。
 *
 * 重試用盡丟 `Error`，訊息是最後一次的原因（`TTS 502`、`連線失敗：…`），給 trace 用。
 */
export async function fetchTtsStream(
  text: string,
  options: FetchTtsOptions = {}
): Promise<ReadableStream<Uint8Array>> {
  const { signal, isCancelled } = options;
  // 包一層再呼叫：直接把全域 fetch 存成變數再呼叫，在部分瀏覽器會因為 this 不對而 Illegal invocation
  const doFetch: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? sleepUnlessAborted;

  let last = "";
  for (let attempt = 1; attempt <= TTS_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw abortError(signal);

    let response: Response | null = null;
    try {
      response = await doFetch(TTS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // body 的形狀跟 app/api/tts/route.ts 一致：`{ text: string }`
        body: JSON.stringify({ text }),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      last = `連線失敗：${error instanceof Error ? error.message : String(error)}`;
    }

    if (response) {
      if (response.ok && response.body) return response.body;
      last = `TTS ${response.status}`;
      // 錯誤的 body（JSON）用不到，放掉連線
      response.body?.cancel().catch(() => {});
      if (!isRetryableTtsStatus(response.status)) break;
    }

    if (isCancelled?.() || attempt === TTS_ATTEMPTS) break;
    await sleep(ttsRetryDelayMs(attempt), signal);
  }
  if (signal?.aborted) throw abortError(signal);
  throw new Error(last || "TTS 失敗");
}
