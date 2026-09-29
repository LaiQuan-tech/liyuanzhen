import { sequenceSpeechStreams, splitForSpeech } from "./speech-segments";
import { fetchTtsStream, sleepUnlessAborted, type FetchTtsOptions } from "./tts-request";

/**
 * 一則答案 → **一條**克隆語音串流。heygen driver（/live、/live2、/live3）與
 * ChibiStage（/live4）共用這一支。
 *
 * 🔴 存在的理由（2026-09-29）：`/api/tts` 超過 600 字直接回 400，而 4xx 不重試——
 * heygen 與 /live4 以前都是整段一次送，長答案就是整段一個字都沒有，畫面上只剩一句「聲音沒出來」。
 * monogram（/chat 的朗讀）先修了：切段、各段依序合成、接成一條播。這支把同一套給另外兩條路用，
 * 免得又出現「/chat 念得出來、/live 念不出來」這種只在長答案才看得到的差別。
 *
 * - 切段：`splitForSpeech`（每段 ≤ 500 字、句界優先）。🔴 ≤ 500 字的答案**只打一次** /api/tts，
 *   body 跟以前一模一樣（`{ text: 去掉頭尾空白的全文 }`）——正常答案 80～125 字，不可以因為這次改動多花任何一次請求。
 * - 重試：每一段都走 `fetchTtsStream`（3 次、400/800ms、4xx 不重試但 429 例外）。
 * - 第一段先要，**要不到就丟錯**：呼叫端照原本「整段失敗」那條路走（onSpeechFailed），語意跟以前一樣。
 * - 後面的段落等上一段收完才要（sequenceSpeechStreams），帶同一個 signal——被打斷時還在飛的那一段一起取消。
 * - 後面某一段要不到、或任何一段讀到一半斷掉：**串流照常收尾**（已經收到的照播），改呼叫 `onSegmentFailed`，
 *   讓呼叫端等她講完再回報——不在她講話時跳提示。
 * - 被打斷（signal abort）不是失敗：不呼叫 `onSegmentFailed`。
 *
 * ⚠️ monogram 沒有改用這一支：它自己的 speak() 是同一套邏輯，外加看門狗與 AudioContext 狀態檢查，
 * 那支剛審查過，這次不動。三邊的切段與重試規格一致，由 speech-segments.ts 與 tts-request.ts 各自的測試鎖住。
 */

export interface OpenSpeechStreamOptions extends FetchTtsOptions {
  /**
   * 第 `index` 段（從 0 起算，共 `total` 段）沒拿到、或讀到一半斷掉。串流照樣正常收尾。
   * ⚠️ 第一段「要不到」不走這裡，是 openSpeechStream 直接丟錯；第一段讀到一半斷掉才走這裡。
   */
  onSegmentFailed(index: number, total: number, error: unknown): void;
  /** 每一塊音訊交出去之前呼叫（給呼叫端的保險計時器重新計時） */
  onChunk?(): void;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("已取消", "AbortError");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 切段、要第一段，回傳接好的一條串流（還沒讀）。見檔頭。
 *
 * 丟錯的情況：沒有要唸的字、第一段重試用盡（訊息是最後一次的原因，給 trace 用）、被打斷（AbortError）。
 */
export async function openSpeechStream(
  text: string,
  options: OpenSpeechStreamOptions
): Promise<ReadableStream<Uint8Array>> {
  const { onSegmentFailed, onChunk, ...request } = options;
  const segments = splitForSpeech(text);
  if (segments.length === 0) throw new Error("沒有要唸的文字");

  const first = await fetchTtsStream(segments[0], request);
  // fetch 不一定理會 abort（回應已經在路上、或已經到了）：打斷之後才到的串流直接丟掉，
  // 否則呼叫端會拿到一條「已經不要的答案」還得自己記得 cancel
  if (request.signal?.aborted) {
    first.cancel().catch(() => {});
    throw abortError(request.signal);
  }

  return sequenceSpeechStreams(
    segments,
    // ⚠️ 第二段以後也要帶同一組 options（signal、isCancelled）：念到一半被打斷時，
    // 還在飛的那一段與它的重試要一起停，不然照樣吃額度、吃一格限流
    (segment, index) => (index === 0 ? Promise.resolve(first) : fetchTtsStream(segment, request)),
    (index, error) => {
      if (request.signal?.aborted) return;
      onSegmentFailed(index, segments.length, error);
    },
    onChunk
  );
}

/**
 * LipSyncPlayer 排完之後再多等多久才算講完。數字與理由同 monogram.ts 的 END_GRACE_MS：
 * 輸出經過 <audio> 元素（iOS 修法），會多 20–60ms 的輸出延遲。
 */
export const PLAYER_END_GRACE_MS = 250;

/** speakWithPlayer 用得到的 LipSyncPlayer 介面。刻意是窄的，測試可以塞假的。 */
export interface SpeechPlayer {
  play(stream: ReadableStream<Uint8Array>): Promise<void>;
  stop(): void;
  /** 已經排進播放圖、還沒播完的秒數（見 LipSyncPlayer.pendingSeconds） */
  readonly pendingSeconds: number;
}

export interface SpeakWithPlayerOptions {
  /** 打斷用（stop、下一則、卸載）。abort 之後什麼都不回報——被打斷不是失敗 */
  signal: AbortSignal;
  /** 這一則的聲音沒有完整出來。每一則最多呼叫一次；`reason` 給 trace 用 */
  onFailed(reason: string): void;
}

/**
 * 用 LipSyncPlayer 唸一則答案：/live4 的 ChibiStage 用它（元件本身在 node 測不到，所以編排放這裡）。
 *
 * - 第一段要不到、或播放本身出錯：停掉已排的聲音、立刻回報。
 * - 後段失敗：已經排進播放圖的讓它唸完，🔴 **唸完才回報**（`player.pendingSeconds` ＋ 寬限）。
 *   這段等待期間 promise 不 resolve——ChibiStage 靠這一點讓「回答中」撐到回報那一刻，
 *   訪客在這段時間按下按鈕（LiveStage.press 看到 speaking 就 stop()）就能把回報一起取消。
 * - 被打斷：什麼都不回報，包括等待中的那個回報。
 *
 * 永遠不丟例外。resolve 的時機：唸完（串流收完）、被打斷、或回報完。
 */
export async function speakWithPlayer(
  player: SpeechPlayer,
  text: string,
  options: SpeakWithPlayerOptions
): Promise<void> {
  const { signal, onFailed } = options;
  // 後段失敗的原因（只記第一個）。⚠️ 用 `as` 宣告型別：寫成 `let partial: string | null = null`
  // 的話 TypeScript 會把它收窄成 null，看不到下面 callback 裡的賦值
  let partial = null as string | null;
  try {
    const stream = await openSpeechStream(text, {
      signal,
      onSegmentFailed: (index, total, error) => {
        partial ??= `第 ${index + 1}/${total} 段：${describe(error)}`;
      },
    });
    await player.play(stream);
    if (signal.aborted || partial === null) return;

    await sleepUnlessAborted(player.pendingSeconds * 1000 + PLAYER_END_GRACE_MS, signal);
    if (signal.aborted) return;
    onFailed(partial);
  } catch (error) {
    // 被打斷不是失敗。訪客自己按的按鈕，畫面上不需要任何解釋。
    if (signal.aborted) return;
    player.stop();
    onFailed(describe(error));
  }
}
