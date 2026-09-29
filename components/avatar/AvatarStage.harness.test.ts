/**
 * AvatarStage 的特性測試治具（characterization harness）。
 *
 * ── 為什麼有這支 ──────────────────────────────────────────────
 * components/avatar/AvatarStage.tsx 管語音頁（/live、/live2、/live3）與 /chat 頭像的 driver 生命週期：
 * 接通串流、閒置與上限計時器、切分頁／離開頁面時收線並回報帳本、執行期 onFatal 之後降級成
 * monogram（「李」字＋老師的克隆聲）。這些邏輯全寫在元件裡，而專案的 vitest 是 node 環境、
 * 沒有 jsdom、也沒有 React Testing Library，所以原本完全沒有自動化測試——db896b6 修的降級行為，
 * 把修正還原之後 vitest 照樣全綠。
 *
 * 這支把 db896b6 當下的行為「釘住」，當作重構的安全網。計畫是把編排「只搬不改寫」地抽到
 * lib/avatar/stage-session.ts，元件變成薄殼：重構期間這支必須一直是綠的，而且**不需要修改**。
 * 要改它才會綠，就代表重構改到了行為——或是治具綁到了內部細節（見最後一節）。
 *
 * ── 怎麼運作 ──────────────────────────────────────────────────
 * 跑的是真的程式碼：AvatarStage.tsx、lib/avatar（index、fallback、heygen、monogram、mock、
 * lipsync-player、tts-request、speech-*）、lib/idle-timer。換成假的只有邊界：
 * - React：下面一百多行的極小 hooks 實作（fakeReact）。元件函式被直接呼叫，JSX 變成
 *   `{ type, props }` 物件，**子元件不會 render**。
 * - next/dynamic 回傳的 VideoAvatar 換成標記函式 VideoAvatarMock，DigitalAvatar 換成 DigitalAvatarMock。
 *   畫面只從這兩個元素判斷：VideoAvatar 在不在、它的 `visible`（影像就緒）、DigitalAvatar（「李」字）在不在。
 *   render 樹裡一出現 VideoAvatar，就把假的 <video> 塞進它的 `videoRef` prop；它消失就清成 null。
 * - LiveAvatar SDK 換成 FakeSession（start 之後下一個 microtask 就緒；stop 會發 CLIENT_INITIATED 斷線；
 *   sdk.startGate 可以讓 start() 卡住）。token 端點可以用 net.tokenGate 卡住、用 net.token 指定狀態碼。
 *   heygen driver 是真的，只外包一層記下它拿到的 hooks（heygenHooks），用來扮演「違約的 driver」。
 * - 網路換成 fakeFetch；Web Audio 換成 FakeAudioContext（永遠 running，只數開了幾個、排了幾段聲音）；
 *   document／window／navigator 是只有用到的欄位的假物件；lib/trace 收進 `traces` 陣列。
 * - 時間：vi 的假時鐘（setTimeout／setInterval／Date）。dynamic import 與 ReadableStream 需要真的事件迴圈，
 *   所以 flush() 交錯跑真的 setImmediate 與假時鐘；mount() 會先把 driver 模組載好。
 * - vitest.config.ts 的 `oxc: { jsx: { runtime: "automatic" } }` 是給這支用的：tsconfig 是
 *   `jsx: "preserve"`（給 Next），vite 照 tsconfig 就不轉 JSX，.tsx 在測試裡根本解析不了。
 *   開了之後 oxc 產生的是 react/jsx-dev-runtime 的 jsxDEV（vitest 不是 production）；兩個 runtime 都假掉了。
 *
 * 觀察點盡量只用元件的公開介面：props 回呼（onTeardown、onSpeechFailed、onSpeakingChange、
 * onAudioAvailableChange）、imperative handle、render 出來的子元素，以及對外的後果——打了哪些 API、
 * 送去合成的是哪幾則、sendBeacon 回報了什麼、SDK 開了幾個 session、開了幾個 AudioContext。
 * 例外兩處：S2、S5 用 `vi.getTimerCount()` 當「機制（第二道）」斷言，寫成 expect.soft，紅了也會繼續跑到
 * 後面的行為斷言；S2 另外看 debug 面板上的 trace（「畫面切回靜態照片」那一筆），因為降級之後再跑收線，
 * 在 monogram 上唯一看得到的後果就是它。
 *
 * ── 保證不連網 ────────────────────────────────────────────────
 * - 全域 fetch 與 window.fetch 都是 fakeFetch，只認三個路徑：/api/avatar-token、/api/tts、
 *   /api/avatar-session/close。其他任何網址（/api/chat、/api/stt、絕對網址……）一律 throw，
 *   而且記進 net.unexpected，afterEach 斷言它是空的——就算呼叫端把錯誤吞掉，測試也會紅。
 *   這個檔案從頭到尾沒有碰過真的 fetch。
 * - LiveAvatar SDK 是沒有 importOriginal 的 vi.mock：真的 SDK（livekit、WebRTC、WebSocket）不會被載入，
 *   不會開計費 session；token 是 fakeFetch 給的，不經過帳本。
 * - navigator.sendBeacon 是 stub；WebSocket／EventSource／XMLHttpRequest 換成一建構就記錄並 throw 的類別。
 * - 不 import node:fs／node:net／node:http，不寫任何檔案。
 *
 * ── 限制：假 React 跟真的 React 的落差（這些情境它抓不到）──────────
 * 標 ★ 的有實驗佐證（拿掉那段正式碼，這支仍然全綠）。
 * 1. ★ 沒有 StrictMode 的 mount→unmount→mount：effect 只跑一次。拿掉 ensureDriver 開頭的 creatingRef
 *    去重仍全綠。「建構要純、mount 可重入、雙掛載只建一個 driver」要另外守（瀏覽器實測或 stage-session 的單元測試）。
 * 2. ★ next/dynamic 在這裡是同步的，VideoAvatar 一出現在 render 樹裡 videoRef 就有值；真的要等 chunk 載完、
 *    元件掛上（「video 晚到」）。拿掉 autoStart 的輪詢（等 <video> 出現那段）或 prepare 的
 *    「沒有 video 就不開 session」護欄，仍全綠。
 * 3. ★ 沒有「使用者手勢」：FakeAudioContext 永遠 running、video.play() 永遠成功、沒有自動播放政策。
 *    把 prepare 的解除靜音／unlockAudio 同步段挪到 preparingRef 早退之後，仍全綠；挪到 await 之後，
 *    只有 S10 會紅（它剛好斷言「沒有在手勢外開 AudioContext」），其餘情境在這裡照樣出聲。
 * 4. setState 用 queueMicrotask 觸發重繪，passive effect 在 render 結束時同步跑完。真的 React 18
 *    非事件觸發的更新走 Scheduler（下一個巨任務），passive effect 在 paint 之後。依賴「重繪落在某個 task
 *    之前還是之後」的時序問題抓不到，也可能因此假紅或假綠。
 * 5. effect 的順序照 React：同一次 commit 先整批 cleanup 再整批 effect；useImperativeHandle 在 passive effect
 *    之前賦值、卸載時清成 null。但沒有 ref callback、ref 物件換新、Suspense、transition 這些東西。
 * 6. hook 只按呼叫順序配對（跟 React 一樣）。這裡多驗了「同一格的 hook 種類不能變」與「每次 render 的
 *    hook 數量要一樣」（條件式呼叫會直接丟錯），但不驗 deps 長度改變這類 React 只會警告的事。
 * 7. props 永遠不變、沒有父層重繪：providerOverride 在執行期改變、callback props 換新函式都測不到。
 * 8. 子元件不 render：浮水印、全身合成（fullBody）的版面、VideoAvatar 內部行為都不在範圍內。
 * 9. 用真的 heygen.ts ＋ FakeSession：綁著 SDK 的事件名、LITE 模式、token 回應格式
 *    （sessionToken／maxSessionSeconds／sessionId）。SDK 升版改了這些，治具不會知道。
 * 10. press() 寫死 LiveStage.press 的同步順序（reportActivity → prepare({ unmute: true })）；
 *    /chat 的「開啟朗讀」是只呼叫 prepare()，寫在 S12。/api/stt、/api/chat 不在這裡，答案直接 finish()。
 *    呼叫端改了順序，治具不會跟著變。
 * 11. flush() 的 turn 數（前 10、後 20）是留的餘裕：2026-09-30 量過，現行碼兩邊都設 0（只靠
 *    advanceTimersByTimeAsync）也全綠。正式碼多了很多層 await、某條測試因為「該發生的事還沒發生」而紅，
 *    先把這兩個數字調大確認。
 *
 * ── 元件加了新 hook 時 ────────────────────────────────────────
 * - 還是 useRef／useState／useCallback／useEffect／useImperativeHandle：不用改，照呼叫順序自動配對。
 * - 用到 fakeReact 沒有的（useMemo、useLayoutEffect、useReducer、useContext、useSyncExternalStore、useId…）：
 *   **每一條測試都會失敗**（元件一 render 就碰到），訊息是 vitest 的 `No "useMemo" export is defined on the "react" mock`（實測過）。
 *   去下面的 fakeReact 照既有的樣子補一個（useMemo 可以照 useCallback 存 factory() 的結果；useLayoutEffect
 *   放進 R.layout 那一批），並在 HookSlot 加一種 kind。fakeReact 整包就是 vi.mock("react") 的內容，不用改別處。
 * - 條件式呼叫 hook：claimSlot 會丟「第 N 個 hook 上一次 render 是 X，這一次是 Y」。重繪跑在 microtask 裡，
 *   所以它會以 vitest 的 Unhandled Error 出現、整輪判定失敗（實測過）。真的 React 也會壞，先修元件。
 * - 新的 import 帶進瀏覽器 API 或新的網址：假物件缺欄位會 TypeError、fakeFetch 會記錄並 throw——都是大聲失敗。
 *   要補就補進對應的假物件，**不可以**放行到真的網路。
 *
 * ── 什麼時候改治具、什麼時候懷疑治具 ─────────────────────────
 * - 該改測試：元件的行為**有意**改變（commit 裡寫清楚為什麼），改對應的斷言；SDK 升版（改 FakeSession）。
 * - 不該改測試：重構（例如抽 stage-session）期間變紅。那代表行為變了，先查正式碼，不要改斷言遷就它。
 * - 該懷疑治具：紅的原因是時序（多一層 await 就紅、調大 flush 的 turn 數就好）；單獨跑綠、一起跑紅
 *   （beforeEach 漏了重設新的模組狀態）。反過來，這裡全綠而瀏覽器上壞掉，多半是上面列的限制：
 *   用 mock driver 在本機瀏覽器重現（NEXT_PUBLIC_AVATAR_PROVIDER=mock、`/live?mockFatal=prepare|speak`，
 *   見 lib/avatar/mock.ts），不要在這裡補一條永遠綠的測試。
 *
 * ── db896b6 的每一項修正由誰守（只還原那一項時會紅的測試）──────────
 * 2026-09-30 實測：複製整個專案到 repo 外，每次從乾淨的 AvatarStage.tsx 只逐字還原一項修正，跑這支。
 *   還原的修正                                                  會紅的測試
 *   degradedRef（onFatal 之後同一個 mount 鎖定 monogram）           S1 S2 S7 S10 S13
 *   onFatal 整段換回舊版                                          S1 S2 S7 S13 S14
 *   onFatal ① 過期／destroy 之後的回報不理（shouldHandleFatal）       S13 S14
 *   onFatal ② 停掉閒置與上限計時器、閒置 ref 清成 null                 S2
 *   onFatal ③ 同步回報 session 結束                                S2
 *   onFatal ⑥ 立刻建好 monogram                                   S1 S2 S7 S13
 *   prepare 回來時 driver 已被換掉就不動畫面、不開計時器（isCurrentDriver） S4 S8
 *   teardown 把閒置 ref 清成 null                                  S5（機制）S11 S12
 *   整支換回 db896b6^                                  S1 S2 S4 S5 S7 S8 S10 S11 S12 S13 S14
 * S3、S6、S9、S15 守的是 db896b6 以前就有的行為，上面每一列都綠是正常的。
 *
 * ── S10 ──────────────────────────────────────────────────────
 * 舊版治具的 S10 沒有斷言，只把數字寫到檔案。現在依 AvatarStage onFatal ⑥ 與 lib/avatar/index.ts
 * preloadMonogram 的註解斷言：按鍵落在「monogram 還沒建好」的縫裡，那一題沒有聲音但要明講一次、
 * 不打 /api/tts、不在手勢外開 AudioContext；下一次按就恢復。理由寫在 S10 裡。
 *
 * ── 重構時會碰到的地方（治具綁到的細節）───────────────────────
 * - vi.mock 的模組：react、react/jsx-*-runtime、next/dynamic、DigitalAvatar、lib/trace、SDK、lib/avatar/heygen。
 *   vi.mock 認的是解析後的檔案，所以 stage-session.ts 換個寫法 import 同一個檔案也吃得到。
 * - mount() 預載的模組清單：新程式碼若在接通途中 dynamic import 別的模組，要加進去，否則要等真的 I/O。
 * - S2 看 trace 標籤「畫面切回靜態照片」；S2、S5 看 vi.getTimerCount()。搬的時候字串不能改、不能多開常駐計時器。
 * - S13、S14 經 heygenHooks 直接呼叫 driver 拿到的 onFatal。stage-session 把 hooks 包一層沒關係，
 *   只要交給 createAvatarDriver 的那一份就是處理 onFatal 的那一份。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type AvatarStageComponent from "@/components/avatar/AvatarStage";
import type { AvatarStageHandle } from "@/components/avatar/AvatarStage";
import type { AvatarDriverHooks } from "@/lib/avatar";

// vi.mock 會被提到檔案最上面，但工廠函式要等第一次 import 那個模組（mount() 裡）才執行，
// 那時下面的變數都已經初始化了，所以工廠可以直接引用它們。

// ── 假 React ─────────────────────────────────────────────────────
interface RefObject<T> {
  current: T;
}
type Deps = readonly unknown[] | undefined;
type EffectBody = () => void | (() => void);

type HookSlot =
  | { kind: "useRef"; ref: RefObject<unknown> }
  | { kind: "useState"; value: unknown; set: (next: unknown) => void }
  | { kind: "useCallback"; fn: unknown; deps: Deps }
  | { kind: "useEffect"; deps: Deps; cleanup: (() => void) | undefined }
  | { kind: "useImperativeHandle"; deps: Deps; target: RefObject<unknown> | null };
type SlotOf<K extends HookSlot["kind"]> = Extract<HookSlot, { kind: K }>;

/** 目前掛著的那一個元件（治具一次只掛一個） */
const R = {
  slots: [] as HookSlot[],
  cursor: 0,
  /** 這次 commit 要跑的 layout 階段工作（useImperativeHandle） */
  layout: [] as Array<() => void>,
  /** 這次 commit 要（重）跑的 passive effect */
  passive: [] as Array<{ slot: SlotOf<"useEffect">; body: EffectBody }>,
  scheduled: false,
  render: null as null | (() => void),
};

function depsChanged(prev: Deps, next: Deps): boolean {
  if (!prev || !next) return true;
  return prev.length !== next.length || prev.some((value, k) => !Object.is(value, next[k]));
}

/** 按呼叫順序拿第 N 格；種類跟上一次 render 不同就丟錯（React 靠順序配對，這裡多驗一道） */
function claimSlot<K extends HookSlot["kind"]>(
  kind: K,
  create: () => SlotOf<K>
): { slot: SlotOf<K>; fresh: boolean } {
  const k = R.cursor++;
  const existing = R.slots[k];
  if (!existing) {
    const slot = create();
    R.slots[k] = slot;
    return { slot, fresh: true };
  }
  if (existing.kind !== kind) {
    throw new Error(
      `假 React：第 ${k} 個 hook 上一次 render 是 ${existing.kind}，這一次是 ${kind}。` +
        "hook 的呼叫順序變了（條件式呼叫？），真的 React 也會壞，先修元件。"
    );
  }
  return { slot: existing as SlotOf<K>, fresh: false };
}

function scheduleRender(): void {
  if (R.scheduled || !R.render) return;
  R.scheduled = true;
  queueMicrotask(() => {
    R.scheduled = false;
    R.render?.();
  });
}

/**
 * 元件 import 的每一個 React 名字都要在這裡。缺了就是 `No "xxx" export is defined on the "react" mock`。
 * 槽位裡存的是 unknown，拿出來時用 `as` 轉回呼叫端的型別：同一格永遠屬於同一個 hook 呼叫（claimSlot 驗過種類）。
 */
const fakeReact = {
  forwardRef<T, P>(render: (props: P, ref: RefObject<T | null>) => unknown) {
    return render;
  },
  useRef<T>(initial: T): RefObject<T> {
    const { slot } = claimSlot("useRef", () => ({ kind: "useRef", ref: { current: initial } }));
    return slot.ref as RefObject<T>;
  },
  useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] {
    const { slot } = claimSlot("useState", () => {
      const created: SlotOf<"useState"> = {
        kind: "useState",
        value: typeof initial === "function" ? (initial as () => S)() : initial,
        set: (next) => {
          const value =
            typeof next === "function" ? (next as (prev: unknown) => unknown)(created.value) : next;
          if (Object.is(value, created.value)) return;
          created.value = value;
          scheduleRender();
        },
      };
      return created;
    });
    return [slot.value as S, slot.set as (next: S | ((prev: S) => S)) => void];
  },
  useCallback<F>(fn: F, deps: readonly unknown[]): F {
    const { slot, fresh } = claimSlot("useCallback", () => ({ kind: "useCallback", fn, deps }));
    if (!fresh && depsChanged(slot.deps, deps)) {
      slot.fn = fn;
      slot.deps = deps;
    }
    return slot.fn as F;
  },
  useEffect(body: EffectBody, deps?: readonly unknown[]): void {
    const { slot, fresh } = claimSlot("useEffect", () => ({ kind: "useEffect", deps, cleanup: undefined }));
    if (fresh || depsChanged(slot.deps, deps)) {
      slot.deps = deps;
      R.passive.push({ slot, body });
    }
  },
  useImperativeHandle<T>(
    target: RefObject<T | null> | null | undefined,
    create: () => T,
    deps?: readonly unknown[]
  ): void {
    const ref = (target ?? null) as RefObject<unknown> | null;
    const { slot, fresh } = claimSlot("useImperativeHandle", () => ({
      kind: "useImperativeHandle",
      deps,
      target: ref,
    }));
    if (fresh || depsChanged(slot.deps, deps)) {
      slot.deps = deps;
      slot.target = ref;
      R.layout.push(() => {
        if (ref) ref.current = create();
      });
    }
  },
};

function commit(): void {
  const layout = R.layout;
  const passive = R.passive;
  R.layout = [];
  R.passive = [];
  for (const run of layout) run();
  // 跟 React 一樣：同一次 commit 先把要重跑的 effect 全部 cleanup，再依序跑新的 effect
  for (const { slot } of passive) {
    const cleanup = slot.cleanup;
    slot.cleanup = undefined;
    cleanup?.();
  }
  for (const { slot, body } of passive) {
    const cleanup = body();
    slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
  }
}

function unmountRoot(): void {
  R.render = null;
  for (const slot of R.slots) {
    if (slot.kind === "useImperativeHandle" && slot.target) slot.target.current = null;
  }
  for (const slot of R.slots) {
    if (slot.kind !== "useEffect") continue;
    const cleanup = slot.cleanup;
    slot.cleanup = undefined;
    cleanup?.();
  }
}

interface FakeElement {
  type: unknown;
  props: Record<string, unknown>;
  key: unknown;
}
function createElement(type: unknown, props: Record<string, unknown> | null, key?: unknown): FakeElement {
  return { type, props: props ?? {}, key };
}
const FRAGMENT = Symbol.for("fake-react.fragment");

vi.mock("react", () => ({ ...fakeReact, default: fakeReact }));
vi.mock("react/jsx-runtime", () => ({ jsx: createElement, jsxs: createElement, Fragment: FRAGMENT }));
vi.mock("react/jsx-dev-runtime", () => ({ jsxDEV: createElement, Fragment: FRAGMENT }));

// ── 子元件與 trace ───────────────────────────────────────────────
function VideoAvatarMock(): null {
  return null;
}
function DigitalAvatarMock(): null {
  return null;
}
vi.mock("next/dynamic", () => ({ default: () => VideoAvatarMock }));
vi.mock("@/components/avatar/DigitalAvatar", () => ({ default: DigitalAvatarMock }));

/** 每一筆是 `標籤` 或 `標籤｜細節`（debug 面板上看到的就是這些） */
const traces: string[] = [];
vi.mock("@/lib/trace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trace")>()),
  trace: (label: string, detail?: string) => {
    traces.push(detail ? `${label}｜${detail}` : label);
  },
}));

// ── 假 LiveAvatar SDK ────────────────────────────────────────────
type SdkListener = (arg?: unknown) => void;
const sdk = {
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
class FakeSession {
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
vi.mock("@heygen/liveavatar-web-sdk", () => ({
  LiveAvatarSession: FakeSession,
  SessionEvent: { SESSION_STREAM_READY: "session_stream_ready", SESSION_DISCONNECTED: "session_disconnected" },
  AgentEventsEnum: { AVATAR_SPEAK_STARTED: "avatar_speak_started", AVATAR_SPEAK_ENDED: "avatar_speak_ended" },
}));

/**
 * 每一個 heygen driver 拿到的 hooks，依建立順序。
 * driver 本身是真的；記下 hooks 是為了模擬「違反 onFatal 契約的 driver」（S13、S14）：
 * 真的 heygen 由 heygen.ts 的 fatalReported／dead 保證「最多報一次、destroy 之後不報」，
 * 元件那一層的守衛（shouldHandleFatal）只有違約的 driver 才碰得到。
 */
const heygenHooks: AvatarDriverHooks[] = [];
vi.mock("@/lib/avatar/heygen", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/avatar/heygen")>();
  return {
    ...real,
    createHeygenDriver: (hooks: AvatarDriverHooks) => {
      heygenHooks.push(hooks);
      return real.createHeygenDriver(hooks);
    },
  };
});

// ── 假 Web Audio（monogram 的 LipSyncPlayer 用）────────────────────
class FakeAudioContext {
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

// ── 假網路 ───────────────────────────────────────────────────────
const SESSION_CLOSE = "/api/avatar-session/close";
const net = {
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
  /** 不該發生的連網嘗試。afterEach 會斷言它是空的 */
  unexpected: [] as string[],
};
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
async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
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
      throw new Error("治具：/api/tts 的 body 形狀變了");
    }
    net.tts.push(text);
    return pcmResponse();
  }
  if (url === SESSION_CLOSE) {
    // sendBeacon 失敗時的退路（這裡的 sendBeacon 不會失敗，走到這裡代表元件改了回報方式）
    net.closeCalls += 1;
    net.closeBodies.push(String(init?.body));
    return new Response("{}", { status: 200 });
  }
  net.unexpected.push(`fetch ${url}`);
  throw new Error(`治具不連網：沒有預期到的請求 ${url}`);
}
function fakeSendBeacon(url: string | URL, data?: BodyInit | null): boolean {
  const target = String(url);
  if (target !== SESSION_CLOSE) {
    net.unexpected.push(`sendBeacon ${target}`);
    return false;
  }
  net.closeCalls += 1;
  if (data instanceof Blob) void data.text().then((text) => net.closeBodies.push(text));
  else net.closeBodies.push(String(data));
  return true;
}
/** WebSocket／EventSource／XMLHttpRequest：一建構就記錄並 throw */
function forbidden(name: string) {
  return class {
    constructor(target?: unknown) {
      net.unexpected.push(`${name} ${String(target)}`);
      throw new Error(`治具不連網：${name}`);
    }
  };
}

// ── 假 DOM ───────────────────────────────────────────────────────
type Listener = () => void;
const docListeners = new Map<string, Set<Listener>>();
const winListeners = new Map<string, Set<Listener>>();
function listen(map: Map<string, Set<Listener>>, type: string, fn: Listener): void {
  let set = map.get(type);
  if (!set) {
    set = new Set();
    map.set(type, set);
  }
  set.add(fn);
}
function dispatch(map: Map<string, Set<Listener>>, type: string): void {
  // 先複製一份：監聽器在被呼叫時可能增刪自己
  for (const fn of Array.from(map.get(type) ?? [])) fn();
}
const fakeDocument = {
  visibilityState: "visible" as DocumentVisibilityState,
  addEventListener: (type: string, fn: Listener) => listen(docListeners, type, fn),
  removeEventListener: (type: string, fn: Listener) => void docListeners.get(type)?.delete(fn),
};
const fakeVideo = { muted: true, poster: "", play: () => Promise.resolve() };

function hide(): void {
  fakeDocument.visibilityState = "hidden";
  dispatch(docListeners, "visibilitychange");
}
function show(): void {
  fakeDocument.visibilityState = "visible";
  dispatch(docListeners, "visibilitychange");
}
function leavePage(): void {
  dispatch(winListeners, "pagehide");
}

// ── 掛載 ─────────────────────────────────────────────────────────
type StageProps = Omit<ComponentProps<typeof AvatarStageComponent>, "ref">;
type RenderStage = (props: StageProps, ref: RefObject<AvatarStageHandle | null>) => unknown;

let tree: unknown = null;
let videoRefSeen: RefObject<unknown> | null = null;

function isElement(node: unknown): node is FakeElement {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}
function findByType(node: unknown, type: unknown): FakeElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isElement(node)) return null;
  if (node.type === type) return node;
  return findByType(node.props.children, type);
}

async function mount(overrides: Partial<StageProps>) {
  // 先把 driver 模組載好：元件裡的 dynamic import 要真的事件迴圈才會完成，假時鐘推不動
  await import("@/lib/avatar/heygen");
  await import("@/lib/avatar/monogram");
  await import("@/lib/avatar/mock");
  await import("@heygen/liveavatar-web-sdk");
  const { default: AvatarStage } = await import("@/components/avatar/AvatarStage");
  // 型別上它是真 React 的 ForwardRefExoticComponent；假 forwardRef 直接回傳 render 函式本身，
  // 所以執行期拿到的就是 (props, ref) => 元素樹。整個檔案只有這一個跨越型別的轉換。
  const renderStage = AvatarStage as unknown as RenderStage;

  const handle: RefObject<AvatarStageHandle | null> = { current: null };
  const calls = {
    speaking: [] as boolean[],
    audioAvailable: [] as boolean[],
    teardown: 0,
    speechFailed: 0,
  };
  const props: StageProps = {
    state: "idle",
    size: "full",
    onSpeakingChange: (speaking) => calls.speaking.push(speaking),
    onAudioAvailableChange: (available) => calls.audioAvailable.push(available),
    onTeardown: () => {
      calls.teardown += 1;
    },
    onSpeechFailed: () => {
      calls.speechFailed += 1;
    },
    ...overrides,
  };

  R.render = () => {
    const isUpdate = R.slots.length > 0;
    R.cursor = 0;
    R.layout = [];
    R.passive = [];
    tree = renderStage(props, handle);
    if (isUpdate && R.cursor !== R.slots.length) {
      throw new Error(`假 React：這次 render 呼叫了 ${R.cursor} 個 hook，上一次是 ${R.slots.length} 個。`);
    }
    // 模擬 VideoAvatar 掛上／卸下 <video>（真的要等 chunk 載完，見檔頭限制 2）
    const video = findByType(tree, VideoAvatarMock);
    if (video) {
      const ref = video.props.videoRef as RefObject<unknown>;
      ref.current = fakeVideo;
      videoRefSeen = ref;
    } else if (videoRefSeen) {
      videoRefSeen.current = null;
    }
    commit();
  };
  R.render();

  const stage = (): AvatarStageHandle => {
    if (!handle.current) throw new Error("imperative handle 還沒掛上（或已經卸載）");
    return handle.current;
  };
  const view = () => {
    const video = findByType(tree, VideoAvatarMock);
    return {
      /** VideoAvatar 在 render 樹裡（provider 需要影像） */
      video: video !== null,
      /** 影像就緒、淡入（VideoAvatar 的 visible） */
      videoVisible: video?.props.visible === true,
      /** 「李」字（DigitalAvatar）在畫面上 */
      monogram: findByType(tree, DigitalAvatarMock) !== null,
    };
  };
  return { stage, calls, view, unmount: unmountRoot };
}

/** 前後各跑幾輪「真的事件迴圈一格＋假時鐘推 0 毫秒」。經驗值，見檔頭限制 11。 */
const TURNS_BEFORE = 10;
const TURNS_AFTER = 20;
const realTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settle(turns: number): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await realTurn();
    await vi.advanceTimersByTimeAsync(0);
  }
}
/** 讓非同步的事跑完，再把假時鐘往前推 ms 毫秒，再讓後續的事跑完 */
async function flush(ms = 0): Promise<void> {
  await settle(TURNS_BEFORE);
  await vi.advanceTimersByTimeAsync(ms);
  await settle(TURNS_AFTER);
}

/**
 * LiveStage.press 的同步段：reportActivity → prepare({ unmute: true })，中間沒有 await。
 * （她正在講話時 LiveStage 會在兩者之間 stop()；需要的測試自己呼叫。）
 */
function press(stage: AvatarStageHandle): void {
  stage.reportActivity();
  void stage.prepare({ unmute: true });
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const TEARDOWN_TRACE = "畫面切回靜態照片";

beforeEach(() => {
  vi.resetModules();
  R.slots = [];
  R.cursor = 0;
  R.layout = [];
  R.passive = [];
  R.scheduled = false;
  R.render = null;
  tree = null;
  videoRefSeen = null;
  traces.length = 0;
  heygenHooks.length = 0;
  sdk.sessions = 0;
  sdk.log = [];
  sdk.listeners = new Map();
  sdk.startGate = null;
  net.token = [];
  net.tokenGate = null;
  net.tokenRequests = 0;
  net.tts = [];
  net.closeCalls = 0;
  net.closeBodies = [];
  net.unexpected = [];
  FakeAudioContext.count = 0;
  FakeAudioContext.scheduled = 0;
  docListeners.clear();
  winListeners.clear();
  fakeDocument.visibilityState = "visible";
  fakeVideo.muted = true;
  fakeVideo.poster = "";

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  // 不吃開發者機器上的設定：沒指定 provider 的頁面（/chat）一律照正式站的預設（monogram）
  vi.stubEnv("NEXT_PUBLIC_AVATAR_PROVIDER", undefined);
  vi.stubGlobal("fetch", fakeFetch);
  vi.stubGlobal("WebSocket", forbidden("WebSocket"));
  vi.stubGlobal("EventSource", forbidden("EventSource"));
  vi.stubGlobal("XMLHttpRequest", forbidden("XMLHttpRequest"));
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("navigator", { sendBeacon: fakeSendBeacon });
  vi.stubGlobal("window", {
    AudioContext: FakeAudioContext,
    fetch: fakeFetch,
    ReadableStream,
    location: { search: "" },
    addEventListener: (type: string, fn: Listener) => listen(winListeners, type, fn),
    removeEventListener: (type: string, fn: Listener) => void winListeners.get(type)?.delete(fn),
  });
});

afterEach(() => {
  R.render = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  expect(net.unexpected, "治具攔到沒有預期的連網嘗試").toEqual([]);
});

// ── 情境 ─────────────────────────────────────────────────────────
const LIVE = { provider: "heygen", autoStart: true, poster: "/p.jpg" } as const;

describe("AvatarStage（真實程式碼）＋假 React／假 SDK／假網路", () => {
  it("S1 autoStart 時 token 被拒：畫面換「李」字；按說話之後答案由 monogram 出聲；之後不再要 token", async () => {
    net.token = [503];
    const { stage, calls, view } = await mount(LIVE);
    await flush(200);
    expect(net.tokenRequests).toBe(1);
    expect(view()).toMatchObject({ video: false, monogram: true });
    expect(calls.speechFailed).toBe(0);
    expect(net.closeCalls).toBe(0); // token 被拒就沒有 session id，沒有東西要回報

    // 降級之後、按說話之前到的答案：放不出聲音（沒有手勢解鎖），要明講，也不白打 /api/tts
    stage().finish("按之前的答案。");
    await flush();
    expect(calls.speechFailed).toBe(1);
    expect(net.tts).toEqual([]);

    for (let round = 0; round < 3; round++) {
      press(stage());
      await flush(3000); // 錄音＋辨識＋生成
      stage().finish(`第 ${round} 題的答案。`);
      await flush(5000);
    }
    expect(net.tts).toEqual(["第 0 題的答案。", "第 1 題的答案。", "第 2 題的答案。"]);
    expect(FakeAudioContext.scheduled).toBeGreaterThanOrEqual(3);
    expect(calls.speechFailed).toBe(1);
    expect(net.tokenRequests).toBe(1);
    expect(sdk.sessions).toBe(0);

    // 切分頁：monogram 沒有 teardown，也不會回頭去要 token
    hide();
    press(stage());
    await flush(200_000);
    expect(net.tokenRequests).toBe(1);
    expect(calls.teardown).toBe(0);
  });

  it("S2 講到一半斷線：speechFailed 一次、同步回報 session 結束、之後都是 monogram；閒置與上限計時器一起停，之後不再收線", async () => {
    const { stage, calls, view } = await mount(LIVE);
    await flush(200);
    expect(sdk.log).toContain("attach");
    expect(view().videoVisible).toBe(true);

    press(stage());
    await flush(3000);
    stage().finish("講到一半的答案。");
    await flush(0);
    expect(calls.speaking.at(-1)).toBe(true);

    sdk.emit("session_disconnected", "UNKNOWN_REASON");
    // 🔴 回報要在斷線的當下、任何 await 之前送出（onFatal ③）
    expect(net.closeCalls).toBe(1);
    await flush(0);
    expect(calls.speechFailed).toBe(1);
    expect(calls.speaking.at(-1)).toBe(false);
    expect(view()).toMatchObject({ video: false, monogram: true });
    expect(net.closeBodies.join()).toContain("sess-1");
    // 機制（第二道，soft：紅了也繼續跑到下面的行為斷言）：降級的這一刻不可以還有待觸發的計時器
    // （閒置、上限都要停，onFatal ②）
    expect.soft(vi.getTimerCount(), "降級之後還有待觸發的計時器").toBe(0);

    const degradedAt = traces.length;
    await flush(80_000); // 斷線前最後一次活動 +75 秒：舊的閒置計時器還在的話，這裡會觸發
    expect(calls.teardown).toBe(0);
    press(stage());
    await flush(3000);
    stage().finish("斷線之後的答案。");
    await flush(5000);
    await flush(100_000); // 接通 +178 秒：舊的上限計時器還在的話，這裡會觸發
    // 行為：降級之後不可以再跑收線。它對 monogram 什麼都不做，唯一的痕跡是一筆「畫面切回靜態照片」——
    // 臉早就沒了，這筆假紀錄會把看 debug 面板查問題的人帶錯方向。
    expect(traces.slice(degradedAt).filter((t) => t.startsWith(TEARDOWN_TRACE))).toEqual([]);
    expect(calls.teardown).toBe(0);
    expect(net.tokenRequests).toBe(1);
    expect(sdk.sessions).toBe(1);
    expect(calls.speechFailed).toBe(1);
    expect(net.tts).toEqual(["講到一半的答案。", "斷線之後的答案。"]);
    expect(FakeAudioContext.scheduled).toBeGreaterThanOrEqual(1);
  });

  it("S3 切分頁 teardown：同步回報 session 結束、收掉串流；下一次按說話照舊重建 heygen（既有行為）", async () => {
    const { stage, calls, view } = await mount(LIVE);
    await flush(200);
    expect(sdk.sessions).toBe(1);
    hide();
    // 🔴 同步：切走的當下就送，不等 destroy（分頁隨時會被凍結）
    expect(net.closeCalls).toBe(1);
    await flush(0);
    expect(calls.teardown).toBe(1);
    expect(sdk.log).toContain("session.stop");
    expect(net.closeBodies.join()).toContain("sess-1");
    show();
    press(stage());
    await flush(200);
    expect(net.tokenRequests).toBe(2);
    expect(sdk.sessions).toBe(2);
    expect(view()).toMatchObject({ video: true, videoVisible: true, monogram: false });
  });

  it("S4 接通途中被收掉（切分頁）：舊的 prepare 回來之後不開計時器、不標影像就緒", async () => {
    const token = gate();
    net.tokenGate = token.promise;
    const { stage, calls, view } = await mount(LIVE);
    await flush(200);
    expect(net.tokenRequests).toBe(1);
    hide(); // 接通途中
    await flush(0);
    expect(calls.teardown).toBe(1);
    token.release();
    await flush(0);
    expect(view().videoVisible).toBe(false);
    // 舊版：這裡會開 75 秒閒置＋上限計時器，到點把之後新開的 session 收掉
    net.tokenGate = null;
    show();
    await flush(10_000);
    press(stage()); // 新的 session 在 +10 秒接上
    await flush(200);
    expect(sdk.log.filter((x) => x === "attach")).toHaveLength(1);
    await flush(70_000); // 距離第一次（被收掉的）prepare 約 80 秒、距離新 session 約 70 秒
    expect(calls.teardown).toBe(1);
  });

  it("S5 teardown 之後的 reportActivity 不可以把停掉的閒置計時器叫回來；新 session 的閒置從它接通那一刻算", async () => {
    const { stage, calls } = await mount(LIVE);
    await flush(200);
    hide();
    await flush(0);
    expect(calls.teardown).toBe(1);
    show();
    // 機制（第二道，soft）：沒有 session 的時候，reportActivity 不可以生出任何計時器。
    // 這一條的「行為」後果只在接通途中才看得到（S11、S12）：接通完成時 prepare 會先收掉舊的計時器再開新的，
    // 所以下面這段正常速度的重接，就算計時器被叫回來了也照樣全綠。
    const timers = vi.getTimerCount();
    stage().reportActivity();
    expect.soft(vi.getTimerCount(), "teardown 之後 reportActivity 叫回了計時器").toBe(timers);

    const token = gate();
    net.tokenGate = token.promise;
    press(stage()); // reportActivity 在 prepare 之前
    await flush(10_000);
    token.release(); // 新 session 在 +10 秒才接上 → 它自己的閒置是 +85 秒
    await flush(200);
    await flush(70_000); // +80 秒
    expect(calls.teardown).toBe(1);
    await flush(10_000); // +90 秒：新 session 自己的閒置到點
    expect(calls.teardown).toBe(2);
  });

  it("S6 /chat（沒指定 provider、不 autoStart）：monogram、不要 token、朗讀出聲、朗讀按鈕可用", async () => {
    const { stage, calls, view } = await mount({ size: "sm" });
    await flush(200);
    expect(view()).toMatchObject({ video: false, monogram: true });
    expect(calls.audioAvailable.at(-1)).toBe(true);
    // ChatPanel「開啟朗讀」：unlockAudio → prepare()
    stage().unlockAudio?.();
    void stage().prepare();
    await flush(0);
    stage().finish("文字對談的答案。");
    await flush(5000);
    expect(net.tokenRequests).toBe(0);
    expect(sdk.sessions).toBe(0);
    expect(net.tts).toEqual(["文字對談的答案。"]);
    expect(calls.speechFailed).toBe(0);
  });

  it("S7 連線中答案在排隊、token 被拒：speechFailed 恰一次、降級後不補說那一則；下一次按之後正常出聲", async () => {
    const token = gate();
    net.tokenGate = token.promise;
    net.token = [503];
    const { stage, calls, view } = await mount(LIVE);
    await flush(200);
    press(stage());
    await flush(3000);
    stage().finish("連線中到的答案。");
    await flush(0);
    token.release();
    await flush(200);
    expect(calls.speechFailed).toBe(1);
    expect(view()).toMatchObject({ video: false, monogram: true });
    await flush(10_000);
    expect(net.tts).toEqual([]);
    press(stage());
    await flush(3000);
    stage().finish("下一題。");
    await flush(5000);
    expect(net.tts).toEqual(["下一題。"]);
    expect(calls.speechFailed).toBe(1);
    expect(net.tokenRequests).toBe(1);
  });

  it("S8 切分頁收掉之後 token 才被拒（prepare 在 destroy 之後失敗）：不降級，下一次按照舊重建 heygen", async () => {
    const token = gate();
    net.tokenGate = token.promise;
    net.token = [503];
    const { stage, calls, view } = await mount(LIVE);
    await flush(200);
    hide();
    await flush(0);
    token.release();
    await flush(200);
    expect(view()).toMatchObject({ video: true, monogram: false });
    net.tokenGate = null;
    show();
    press(stage());
    await flush(200);
    expect(net.tokenRequests).toBe(2);
    expect(sdk.sessions).toBe(1);
    expect(view()).toMatchObject({ video: true, videoVisible: true });
    expect(calls.speechFailed).toBe(0);
  });

  it("S9 卸載時計時器還在：到點不可以丟錯、不可以回報 teardown", async () => {
    const { calls, unmount } = await mount(LIVE);
    await flush(200);
    expect(sdk.log).toContain("attach");
    unmount();
    await flush(0);
    expect(sdk.log).toContain("session.stop");
    await flush(200_000);
    expect(calls.teardown).toBe(0);
    // ⚠️ 卸載只 destroy、不回報 session 結束（既有行為，範圍外的已知缺口）。故意不斷言，
    // 修掉的時候在這裡補「closeCalls 是 1」。
  });

  it("S10 斷線之後、monogram 還沒建好就按說話：那一題沒聲音但要明講一次，不在手勢外開 AudioContext；下一次按就恢復", async () => {
    // 真的瀏覽器裡，建 heygen 時 preloadMonogram 已經把 monogram 的 chunk 載好，onFatal 之後
    // monogram 在同一個 task 的 microtask 裡就進了 driverRef，之後才輪得到 click（lib/avatar/index.ts）。
    // 這道縫只剩「預載還沒完就斷線」（網路差的時候，也正是最容易斷線的時候）。治具推不慢 chunk，
    // 所以用「同一個 task 裡按下去」代表「按鍵落在 monogram 建好之前」。
    const { stage, calls } = await mount(LIVE);
    await flush(200);
    sdk.emit("session_disconnected", "UNKNOWN_REASON"); // 閒置時斷線 → onFatal → 開始建 monogram
    press(stage()); // driverRef 還是 null：手勢裡的 unlockAudio 落空
    await flush(3000);
    stage().finish("這一題的答案。");
    await flush(5000);
    // 依 onFatal ⑥：降級之後、被手勢解鎖之前到的答案放不出聲音，由 monogram 回報 onSpeechFailed（恰一次）；
    // 放不出來就不打 /api/tts；🔴 也不可以為了補救在手勢外開 AudioContext（suspended、resume 可能永遠不回來）
    expect(calls.speechFailed).toBe(1);
    expect(net.tts).toEqual([]);
    expect(FakeAudioContext.count).toBe(0);

    press(stage()); // 這一次 monogram 已經在了：手勢裡解鎖
    await flush(3000);
    stage().finish("再下一題。");
    await flush(5000);
    expect(net.tts).toEqual(["再下一題。"]);
    expect(FakeAudioContext.count).toBe(1);
    expect(FakeAudioContext.scheduled).toBeGreaterThanOrEqual(1);
    expect(calls.speechFailed).toBe(1);
    expect(net.tokenRequests).toBe(1);
    expect(sdk.sessions).toBe(1);
  });

  it("S11 切分頁回來按說話、接通卡住超過 75 秒：接通途中不可以被閒置計時器收掉（閒置從接通那一刻才算）", async () => {
    // LiveStage.press 先 reportActivity 再 prepare。teardown 停掉的閒置計時器要是還掛在 ref 上，
    // 這一下會把它叫回來（75 秒後到點）；接通完成時 prepare 會先收掉舊的再開新的，所以只有
    // 「接通還沒完成就到點」會出事：它把正在接的 session 收掉、onTeardown 讓頁面重設對話。
    const { stage, calls, view } = await mount(LIVE);
    await flush(200);
    hide();
    await flush(0);
    expect(calls.teardown).toBe(1);
    show();
    stage().finish("切回來才到的答案。"); // 上一輪的答案現在才到：沒有 driver，明講沒聲音（也是一次活動）
    expect(calls.speechFailed).toBe(1);
    await flush(1000);

    const start = gate();
    sdk.startGate = start.promise; // LiveAvatar 的 start() 卡住
    press(stage());
    await flush(76_000); // 按下 +76 秒：還在接
    expect(calls.teardown).toBe(1);
    start.release();
    await flush(200);
    expect(view()).toMatchObject({ video: true, videoVisible: true });
    expect(sdk.log.filter((x) => x === "attach")).toHaveLength(2);
    await flush(76_000); // 接通 +76 秒：新 session 自己的閒置到點（照常）
    expect(calls.teardown).toBe(2);
  });

  it("S12 呼叫端只呼叫 prepare()、前面沒有 reportActivity：切分頁後有過活動，72 秒後重接、接通要 5 秒——接通途中不可以被收掉", async () => {
    // 跟 S11 同一條規則，換一種呼叫順序。ChatPanel 的「開啟朗讀」就是只呼叫 unlockAudio → prepare()
    // （/chat 正式站是 monogram 不計費，設成 heygen／mock 才走得到收線這條路；但這是 handle 的契約，跟誰呼叫無關）。
    // 復活的閒置計時器照「最後一次活動」算，所以接通的那幾秒內就可能到點。
    const { stage, calls, view } = await mount(LIVE);
    await flush(200);
    hide();
    await flush(0);
    expect(calls.teardown).toBe(1);
    show();
    stage().push("切回來之後");
    stage().finish("切回來之後的答案。"); // 活動（push／finish 都會 reportActivity）；沒有 driver，明講沒聲音
    expect(calls.speechFailed).toBe(1);
    await flush(72_000);

    const token = gate();
    net.tokenGate = token.promise;
    stage().unlockAudio?.();
    void stage().prepare(); // 不先 reportActivity
    await flush(5_000); // 距離上一次活動 +77 秒：還在接
    expect(calls.teardown).toBe(1);
    token.release();
    await flush(200);
    expect(view()).toMatchObject({ video: true, videoVisible: true });
    expect(sdk.log.filter((x) => x === "attach")).toHaveLength(2);
  });

  it("S13 違約的 driver 在 monogram 接手之後又報一次 fatal：當成過期回報不理，已經被手勢解鎖的老師聲音照常出聲", async () => {
    const { stage, calls } = await mount(LIVE);
    await flush(200);
    sdk.emit("session_disconnected", "UNKNOWN_REASON"); // 第一次（合法的）回報 → 降級，monogram 接手
    await flush(0);
    press(stage()); // 手勢解鎖 monogram
    await flush(1000); // 錄音中……
    expect(heygenHooks).toHaveLength(1);
    heygenHooks[0].onFatal(new Error("同一個 heygen driver 遲到的第二次回報"));
    await flush(2000);
    stage().finish("這一題的答案。");
    await flush(5000);
    // 沒守住的話：正在用的 monogram 被當成失效的 driver 收掉、換一個沒解鎖的——這一題沒聲音
    expect(net.tts).toEqual(["這一題的答案。"]);
    expect(calls.speechFailed).toBe(0);
    expect(FakeAudioContext.count).toBe(1);
    expect(net.tokenRequests).toBe(1);
  });

  it("S14 違約的 driver 在被收掉（切分頁 destroy）之後才報 fatal：不可以降級；下一次按照舊重建 heygen", async () => {
    const { stage, calls, view } = await mount(LIVE);
    await flush(200);
    hide();
    await flush(0);
    expect(calls.teardown).toBe(1);
    expect(heygenHooks).toHaveLength(1);
    heygenHooks[0].onFatal(new Error("destroy 之後才報"));
    await flush(0);
    expect(view()).toMatchObject({ video: true, monogram: false }); // 畫面沒有換成「李」字
    show();
    press(stage());
    await flush(200);
    expect(net.tokenRequests).toBe(2);
    expect(view()).toMatchObject({ video: true, videoVisible: true, monogram: false });
  });

  it("S15 離開頁面（pagehide）：當下同步送出 session 結束，接著收掉串流", async () => {
    const { calls } = await mount(LIVE);
    await flush(200);
    leavePage();
    // 🔴 分頁隨時會被殺掉：回報一定要在第一個 await 之前送出
    expect(net.closeCalls).toBe(1);
    await flush(0);
    expect(net.closeBodies.join()).toContain("sess-1");
    expect(sdk.log).toContain("session.stop");
    expect(calls.teardown).toBe(1);
  });
});
