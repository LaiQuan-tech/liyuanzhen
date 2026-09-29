/**
 * stage-session 測試共用的假物件。只有測試會 import（stage-session.test.ts、stage-session.scenarios.test.ts、
 * components/avatar/AvatarStage.harness.test.ts），正式碼不會用到。檔名刻意不是 *.test.ts，vitest 不會把它當測試跑。
 *
 * ── 不連網的保證（三支測試共用這一套）──────────────────────────────
 * - installNetworkTraps() 把全域 fetch 換成 fakeFetch：只認三個路徑（/api/avatar-token、/api/tts、
 *   /api/avatar-session/close），其他任何網址（/api/chat、/api/stt、絕對網址……）一律記進 net.unexpected 並 throw。
 *   就算呼叫端把錯誤吞掉，afterEach 裡的 expectNoUnexpectedNetwork() 也會讓測試紅。這個檔案從頭到尾沒有碰過真的 fetch。
 * - navigator.sendBeacon 是 stub；WebSocket／EventSource／XMLHttpRequest 換成一建構就記錄並 throw 的類別。
 * - LiveAvatar SDK 由各測試檔用 vi.mock 換成這裡的 fakeSdkModule（沒有 importOriginal，真的 SDK 不會被載入、不會開計費 session）。
 * - 不 import node:fs／node:net／node:http，不寫任何檔案。
 *
 * ⚠️ vi.mock 必須寫在各測試檔裡（它只提升到自己那個檔案的最上面）。這裡只提供工廠要回傳的東西；
 * 工廠在第一次 import 被換掉的模組時才執行，那時這個模組早就載入完了，所以可以直接引用這裡的 export。
 */
import { expect, vi } from "vitest";
import type { AvatarDriverHooks } from "./types";

// ── 假網路 ───────────────────────────────────────────────────────
export const SESSION_CLOSE = "/api/avatar-session/close";

export const net = {
  /** 每次 /api/avatar-token 的狀態碼（依序取用）；空的就是 200 */
  token: [] as number[],
  /** 不是 null 時 /api/avatar-token 會等它（模擬連線中） */
  tokenGate: null as Promise<void> | null,
  tokenRequests: 0,
  /** 送去 /api/tts 的每一則文字（合成一次＝花一次 ElevenLabs 額度） */
  tts: [] as string[],
  /** 「session 結束」回報被呼叫的次數。呼叫的當下就 +1，用來驗「同步、在任何 await 之前」 */
  closeCalls: 0,
  /** 回報的內容（sendBeacon 的 Blob 要 await 才讀得到，所以要 flush 之後再看） */
  closeBodies: [] as string[],
  /** 每一次回報走哪一條路 */
  closeVia: [] as Array<"beacon" | "fetch">,
  /** true 時 sendBeacon 回 false（瀏覽器拒收），元件要退到 fetch keepalive */
  beaconRefuses: false,
  /** 不該發生的連網嘗試。afterEach 用 expectNoUnexpectedNetwork() 斷言它是空的 */
  unexpected: [] as string[],
};

export function resetNet(): void {
  net.token = [];
  net.tokenGate = null;
  net.tokenRequests = 0;
  net.tts = [];
  net.closeCalls = 0;
  net.closeBodies = [];
  net.closeVia = [];
  net.beaconRefuses = false;
  net.unexpected = [];
}

function pcmResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(48_000)); // 24 kHz 16-bit 單聲道 → 1 秒
        controller.close();
      },
    }),
    { status: 200 }
  );
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = requestUrl(input);
  if (url === "/api/avatar-token") {
    net.tokenRequests += 1;
    const n = net.tokenRequests;
    if (net.tokenGate) await net.tokenGate;
    const status = net.token.shift() ?? 200;
    if (status !== 200) return new Response(JSON.stringify({ reason: "budget_exhausted" }), { status });
    return new Response(
      JSON.stringify({ sessionToken: `token-${n}`, maxSessionSeconds: 180, sessionId: `sess-${n}` }),
      { status: 200 }
    );
  }
  if (url === "/api/tts") {
    // body 的形狀跟 app/api/tts/route.ts 一致：`{ text: string }`。對不上就記下來（呼叫端會把錯誤吞成「沒聲音」）
    let text: unknown;
    try {
      text = (JSON.parse(String(init?.body)) as { text?: unknown }).text;
    } catch {
      text = undefined;
    }
    if (typeof text !== "string") {
      net.unexpected.push(`/api/tts 的 body 不是 { text }：${String(init?.body)}`);
      throw new Error("測試：/api/tts 的 body 形狀變了");
    }
    net.tts.push(text);
    return pcmResponse();
  }
  if (url === SESSION_CLOSE) {
    // sendBeacon 被拒時的退路（fetch keepalive）
    net.closeCalls += 1;
    net.closeVia.push("fetch");
    net.closeBodies.push(String(init?.body));
    return new Response("{}", { status: 200 });
  }
  net.unexpected.push(`fetch ${url}`);
  throw new Error(`測試不連網：沒有預期到的請求 ${url}`);
}

export function fakeSendBeacon(url: string | URL, data?: BodyInit | null): boolean {
  const target = String(url);
  if (target !== SESSION_CLOSE) {
    net.unexpected.push(`sendBeacon ${target}`);
    return false;
  }
  if (net.beaconRefuses) return false;
  net.closeCalls += 1;
  net.closeVia.push("beacon");
  if (data instanceof Blob) void data.text().then((text) => net.closeBodies.push(text));
  else net.closeBodies.push(String(data));
  return true;
}

/** WebSocket／EventSource／XMLHttpRequest：一建構就記錄並 throw */
function forbidden(name: string) {
  return class {
    constructor(target?: unknown) {
      net.unexpected.push(`${name} ${String(target)}`);
      throw new Error(`測試不連網：${name}`);
    }
  };
}

/**
 * 換掉所有會連網的全域。每個 beforeEach 呼叫；afterEach 用 vi.unstubAllGlobals() 還原。
 * window 由各測試自己決定要不要給（有些情境刻意沒有 window，例如 trace 在 node 會直接略過）。
 */
export function installNetworkTraps(): void {
  vi.stubGlobal("fetch", fakeFetch);
  vi.stubGlobal("WebSocket", forbidden("WebSocket"));
  vi.stubGlobal("EventSource", forbidden("EventSource"));
  vi.stubGlobal("XMLHttpRequest", forbidden("XMLHttpRequest"));
  vi.stubGlobal("navigator", { sendBeacon: fakeSendBeacon });
}

/** afterEach 呼叫：任何沒有預期到的連網嘗試都讓測試紅 */
export function expectNoUnexpectedNetwork(): void {
  expect(net.unexpected, "攔到沒有預期的連網嘗試").toEqual([]);
}

// ── 假 LiveAvatar SDK ────────────────────────────────────────────
type SdkListener = (arg?: unknown) => void;

export const sdk = {
  /** new LiveAvatarSession 的次數 */
  sessions: 0,
  /** 最後一個 session 掛的事件（emit 只送到它） */
  listeners: new Map<string, SdkListener>(),
  log: [] as string[],
  /** 不是 null 時 start() 會卡在這裡（模擬接通卡住） */
  startGate: null as Promise<void> | null,
  emit(event: string, arg?: unknown): void {
    sdk.listeners.get(event)?.(arg);
  },
};

export function resetSdk(): void {
  sdk.sessions = 0;
  sdk.listeners = new Map();
  sdk.log = [];
  sdk.startGate = null;
}

/** start 之後下一個 microtask 就緒；stop 會發 CLIENT_INITIATED 斷線（跟真的 SDK 一樣） */
export class FakeSession {
  readonly mode = "LITE";
  constructor() {
    sdk.sessions += 1;
    sdk.listeners = new Map();
  }
  on(event: string, cb: SdkListener): void {
    sdk.listeners.set(event, cb);
  }
  once(event: string, cb: SdkListener): void {
    sdk.listeners.set(event, cb);
  }
  async start(): Promise<void> {
    sdk.log.push("start");
    if (sdk.startGate) await sdk.startGate;
    queueMicrotask(() => sdk.emit("session_stream_ready"));
  }
  attach(): void {
    sdk.log.push("attach");
  }
  interrupt(): void {
    sdk.log.push("interrupt");
  }
  repeat(): void {}
  repeatAudio(): void {
    sdk.log.push("repeatAudio");
  }
  async stop(): Promise<void> {
    sdk.log.push("session.stop");
    sdk.emit("session_disconnected", "CLIENT_INITIATED");
  }
}

/** vi.mock("@heygen/liveavatar-web-sdk", () => fakeSdkModule) 用 */
export const fakeSdkModule = {
  LiveAvatarSession: FakeSession,
  SessionEvent: { SESSION_STREAM_READY: "session_stream_ready", SESSION_DISCONNECTED: "session_disconnected" },
  AgentEventsEnum: { AVATAR_SPEAK_STARTED: "avatar_speak_started", AVATAR_SPEAK_ENDED: "avatar_speak_ended" },
};

/**
 * 每一個 heygen driver 拿到的 hooks，依建立順序（測試檔用 vi.mock 把 createHeygenDriver 包一層記下來）。
 * 用來模擬「違反 onFatal 契約的 driver」：真的 heygen 由 heygen.ts 的 fatalReported／dead 保證
 * 「最多報一次、destroy 之後不報」，stage-session 那一層的守衛（shouldHandleFatal）只有違約的 driver 才碰得到。
 */
export const heygenHooks: AvatarDriverHooks[] = [];

// ── 假 Web Audio（monogram 的 LipSyncPlayer 用）────────────────────
export class FakeAudioContext {
  /** 開過幾個 AudioContext（monogram 只在 unlockAudio，也就是手勢裡才開） */
  static count = 0;
  /** 排進播放圖的聲音段數 */
  static scheduled = 0;
  state: AudioContextState = "running";
  currentTime = 0;
  readonly destination = {};
  constructor() {
    FakeAudioContext.count += 1;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = "closed";
    return Promise.resolve();
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return { duration: length / sampleRate, length, sampleRate, getChannelData: () => data };
  }
  createBufferSource() {
    return {
      buffer: null as unknown,
      onended: null as null | (() => void),
      connect() {},
      disconnect() {},
      stop() {},
      start() {
        FakeAudioContext.scheduled += 1;
      },
    };
  }
}

export function resetAudio(): void {
  FakeAudioContext.count = 0;
  FakeAudioContext.scheduled = 0;
}

// ── trace ────────────────────────────────────────────────────────
/** 每一筆是 `標籤` 或 `標籤｜細節`（debug 面板上看到的就是這些） */
export const traces: string[] = [];
export function recordTrace(label: string, detail?: string): void {
  traces.push(detail ? `${label}｜${detail}` : label);
}

// ── 假 <video> ───────────────────────────────────────────────────
export interface FakeVideo {
  muted: boolean;
  poster: string;
  /** play() 被呼叫的次數 */
  plays: number;
  play(): Promise<void>;
}
export function createFakeVideo(): FakeVideo {
  const video: FakeVideo = {
    muted: true,
    poster: "",
    plays: 0,
    play() {
      video.plays += 1;
      return Promise.resolve();
    },
  };
  return video;
}
/** 程式碼只碰 muted／poster／play()，所以用這個小物件冒充 <video>。整個測試只有這一個跨越型別的轉換。 */
export function asVideo(video: FakeVideo | null): HTMLVideoElement | null {
  return video as unknown as HTMLVideoElement | null;
}

// ── 時間 ─────────────────────────────────────────────────────────
/** 前後各跑幾輪「真的事件迴圈一格＋假時鐘推 0 毫秒」。2026-09-30 量過現行碼設 0 也夠，這是留給多幾層 await 的餘裕。 */
const TURNS_BEFORE = 10;
const TURNS_AFTER = 20;
const realTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settle(turns: number): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await realTurn();
    await vi.advanceTimersByTimeAsync(0);
  }
}
/**
 * 讓非同步的事跑完，再把假時鐘往前推 ms 毫秒，再讓後續的事跑完。
 * ⚠️ 要先 vi.useFakeTimers({ toFake: FAKE_TIMERS })——dynamic import 與 ReadableStream 需要真的事件迴圈，
 * 所以 setImmediate 不能假。
 */
export async function flush(ms = 0): Promise<void> {
  await settle(TURNS_BEFORE);
  await vi.advanceTimersByTimeAsync(ms);
  await settle(TURNS_AFTER);
}
export const FAKE_TIMERS: Array<"setTimeout" | "clearTimeout" | "setInterval" | "clearInterval" | "Date"> = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "Date",
];

/** 一個由測試決定什麼時候放行的 promise */
export function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
