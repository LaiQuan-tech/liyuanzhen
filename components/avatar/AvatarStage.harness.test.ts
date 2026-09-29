/**
 * AvatarStage 的接線測試（wiring test）。
 *
 * ── 現在測什麼 ──────────────────────────────────────────────
 * 只測元件有沒有把 lib/avatar/stage-session.ts 接對：session 每個 mount 只建一次；三個 effect 只轉呼叫
 * （mount／unmount、visibilitychange 與 pagehide → teardown、autoStart）；imperative handle 同步轉呼叫；
 * ui 回呼改 state 之後畫面跟著變；callback props 換新函式之後 session 呼叫到的是最新的；providerOverride 原樣傳入。
 * session 在這裡是假的（vi.mock("@/lib/avatar/stage-session")，只記錄呼叫）。編排本身的測試在：
 * - lib/avatar/stage-session.test.ts：劇本式假 driver 的單元測試（每一項修正、StrictMode、video 晚到、手勢同步段、同步回報）
 * - lib/avatar/stage-session.scenarios.test.ts：真的 driver＋假 SDK 跑 S1–S15 情境
 *
 * ── 歷史 ────────────────────────────────────────────────────
 * 到抽出 stage-session 的那個 commit（新增 lib/avatar/stage-session.ts 的那一個）為止，這支是重構用的特性測試安全網：假 React 跑真的元件＋真的 driver＋假 SDK，
 * S1–S15 把 db896b6 的降級行為釘住，抽 session 的時候一個字都沒改照綠。編排搬出去之後，那些情境改成直接驅動
 * session（上面兩支），這裡瘦身成只測接線。完整版：
 *   git show $(git log --diff-filter=A --format=%h -- lib/avatar/stage-session.ts):components/avatar/AvatarStage.harness.test.ts
 *
 * ── 怎麼運作 ─────────────────────────────────────────────────
 * 下面的極小假 React（fakeReact）直接呼叫元件函式，JSX 變成 `{ type, props }` 物件，子元件不 render。
 * VideoAvatar（next/dynamic）與 DigitalAvatar 換成標記函式，畫面只看它們在不在、VideoAvatar 的 `visible`。
 * render 樹裡一出現 VideoAvatar，就把假的 <video> 塞進它的 `videoRef` prop（它消失就清成 null），所以 session 的
 * getVideo() 讀得到。vitest.config.ts 的 `oxc: { jsx: { runtime: "automatic" } }` 就是為了這支：tsconfig 是
 * `jsx: "preserve"`（給 Next），不加的話 .tsx 在測試裡解析不了；開了之後產生的是 react/jsx-dev-runtime 的 jsxDEV。
 *
 * ── 假 React 的限制（只列跟接線有關的）──────────────────────────
 * 1. StrictMode 只模擬一半：mount(props, { strict: true }) 會在第一次 commit 之後把 effect 整批拆掉再整批接上
 *    （跟 React 18 開發模式一樣：先全部 cleanup、再全部重跑；imperative handle 先清成 null 再接回去）。但**沒有**
 *    雙 render，也不會把 useState 的初始化函式跑兩次——createStageSession 被跑兩次、丟掉一個的情況這裡看不到，
 *    所以它的建構必須是純的，由 stage-session.test.ts 守。
 * 2. setState 用 queueMicrotask 觸發重繪，passive effect 在 render 結束時同步跑完；真的 React 18 非事件觸發的更新
 *    走 Scheduler（下一個巨任務），passive effect 在 paint 之後。依賴這個時序的問題抓不到。
 * 3. hook 只按呼叫順序配對。這裡多驗了「同一格的種類不能變」與「每次 render 的數量一樣」（條件式呼叫會大聲失敗），
 *    但不驗 deps 長度改變這類 React 只會警告的事。
 * 4. next/dynamic 在這裡是同步的：VideoAvatar 一出現在 render 樹裡 videoRef 就有值（<video> 晚到由 stage-session.test.ts 守）。
 * 5. 沒有 DOM、沒有使用者手勢：visibilitychange／pagehide 由 hide()／show()／leavePage() 直接呼叫掛上的監聽器。
 *    子元件不 render：浮水印、全身合成的版面、VideoAvatar 內部都不在範圍內。
 *
 * ── 元件加了新 hook 時 ─────────────────────────────────────────
 * - 還是 useRef／useState／useEffect／useImperativeHandle：不用改，照呼叫順序自動配對。
 * - 用到 fakeReact 沒有的（useMemo、useLayoutEffect、useReducer、useContext、useSyncExternalStore、useId…）：每一條測試
 *   都會失敗，訊息是 vitest 的 `No "useMemo" export is defined on the "react" mock`。去下面的 fakeReact 照既有的樣子補一個
 *   （useMemo 可以照 useCallback 存 factory() 的結果；useLayoutEffect 放進 R.layout 那一批），並在 HookSlot 加一種 kind。
 *   fakeReact 整包就是 vi.mock("react") 的內容，不用改別處。
 * - 條件式呼叫 hook：claimSlot 會丟「第 N 個 hook 上一次 render 是 X，這一次是 Y」。重繪跑在 microtask 裡，
 *   所以它會以 vitest 的 Unhandled Error 出現、整輪判定失敗。真的 React 也會壞，先修元件。
 *
 * ── 不連網 ──────────────────────────────────────────────────
 * 這支裡面沒有任何東西應該連網（session 是假的、driver 根本不會被載入）。installNetworkTraps() 仍然把 fetch 換成陷阱、
 * WebSocket／EventSource／XMLHttpRequest 一建構就 throw，afterEach 斷言沒有任何預期外的連網
 * （見 lib/avatar/stage-session.fixtures.ts）。不 import node:fs／node:net／node:http，不寫任何檔案。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type AvatarStageComponent from "@/components/avatar/AvatarStage";
import type { AvatarStageHandle } from "@/components/avatar/AvatarStage";
import type { StageSession, StageSessionOptions } from "@/lib/avatar/stage-session";
import {
  FAKE_TIMERS,
  createFakeVideo,
  expectNoUnexpectedNetwork,
  flush,
  installNetworkTraps,
  resetNet,
} from "@/lib/avatar/stage-session.fixtures";

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
  | { kind: "useEffect"; deps: Deps; body: EffectBody; cleanup: (() => void) | undefined }
  | { kind: "useImperativeHandle"; deps: Deps; target: RefObject<unknown> | null; create: () => unknown };
type SlotOf<K extends HookSlot["kind"]> = Extract<HookSlot, { kind: K }>;

/** 目前掛著的那一個元件（一次只掛一個） */
const R = {
  slots: [] as HookSlot[],
  cursor: 0,
  /** 這次 commit 要跑的 layout 階段工作（useImperativeHandle） */
  layout: [] as Array<() => void>,
  /** 這次 commit 要（重）跑的 passive effect */
  passive: [] as Array<SlotOf<"useEffect">>,
  scheduled: false,
  renders: 0,
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
    const { slot, fresh } = claimSlot("useEffect", () => ({
      kind: "useEffect",
      deps,
      body,
      cleanup: undefined,
    }));
    if (fresh || depsChanged(slot.deps, deps)) {
      slot.deps = deps;
      slot.body = body;
      R.passive.push(slot);
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
      create,
    }));
    if (fresh || depsChanged(slot.deps, deps)) {
      slot.deps = deps;
      slot.target = ref;
      slot.create = create;
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
  for (const slot of passive) {
    const cleanup = slot.cleanup;
    slot.cleanup = undefined;
    cleanup?.();
  }
  for (const slot of passive) {
    const cleanup = slot.body();
    slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
  }
}

/** 把所有 effect 拆掉：imperative handle 清成 null、passive effect 的 cleanup 全部跑一遍 */
function detachEffects(): void {
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

/** StrictMode 開發模式的 effect 重播：整批拆掉，再整批接上（沒有雙 render，見檔頭限制 1） */
function replayEffectsForStrictMode(): void {
  detachEffects();
  for (const slot of R.slots) {
    if (slot.kind === "useImperativeHandle" && slot.target) slot.target.current = slot.create();
  }
  for (const slot of R.slots) {
    if (slot.kind !== "useEffect") continue;
    const cleanup = slot.body();
    slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
  }
}

function unmountRoot(): void {
  R.render = null;
  detachEffects();
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

// ── 子元件 ───────────────────────────────────────────────────────
function VideoAvatarMock(): null {
  return null;
}
function DigitalAvatarMock(): null {
  return null;
}
vi.mock("next/dynamic", () => ({ default: () => VideoAvatarMock }));
vi.mock("@/components/avatar/DigitalAvatar", () => ({ default: DigitalAvatarMock }));

// ── 假 session：只記錄呼叫 ─────────────────────────────────────────
interface SessionCall {
  method: keyof StageSession;
  args: unknown[];
}
interface FakeStageSession {
  /** 元件交給 createStageSession 的東西 */
  options: StageSessionOptions;
  calls: SessionCall[];
  /** prepare 回傳的就是這一個（驗「回傳值原樣」） */
  prepareResult: Promise<void>;
  /** autoStart 回傳的取消函式被呼叫了幾次 */
  autoStartCancels: number;
}
const sessions: FakeStageSession[] = [];

function createFakeSession(options: StageSessionOptions): StageSession {
  const record: FakeStageSession = {
    options,
    calls: [],
    prepareResult: Promise.resolve(),
    autoStartCancels: 0,
  };
  sessions.push(record);
  const call = (method: keyof StageSession, args: unknown[]) => {
    record.calls.push({ method, args });
  };
  return {
    mount: () => call("mount", []),
    unmount: () => call("unmount", []),
    teardown: (why) => {
      call("teardown", [why]);
      return Promise.resolve();
    },
    autoStart: () => {
      call("autoStart", []);
      return () => {
        record.autoStartCancels += 1;
      };
    },
    prepare: (prepareOptions) => {
      call("prepare", [prepareOptions]);
      return record.prepareResult;
    },
    unlockAudio: () => call("unlockAudio", []),
    push: (delta) => call("push", [delta]),
    finish: (fullText) => call("finish", [fullText]),
    stop: () => call("stop", []),
    reportActivity: () => call("reportActivity", []),
  };
}
vi.mock("@/lib/avatar/stage-session", () => ({ createStageSession: createFakeSession }));

const methods = (session: FakeStageSession) => session.calls.map((c) => c.method);

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
const fakeVideo = createFakeVideo();

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
function listenerCount(): number {
  return (docListeners.get("visibilitychange")?.size ?? 0) + (winListeners.get("pagehide")?.size ?? 0);
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

async function mount(overrides: Partial<StageProps>, options: { strict?: boolean } = {}) {
  const { default: AvatarStage } = await import("@/components/avatar/AvatarStage");
  // 型別上它是真 React 的 ForwardRefExoticComponent；假 forwardRef 直接回傳 render 函式本身，
  // 所以執行期拿到的就是 (props, ref) => 元素樹。整個檔案只有這一個跨越型別的轉換。
  const renderStage = AvatarStage as unknown as RenderStage;
  const handle: RefObject<AvatarStageHandle | null> = { current: null };
  const props: StageProps = {
    state: "idle",
    size: "full",
    onSpeakingChange: () => {},
    ...overrides,
  };

  R.render = () => {
    const isUpdate = R.slots.length > 0;
    R.cursor = 0;
    R.layout = [];
    R.passive = [];
    R.renders += 1;
    tree = renderStage(props, handle);
    if (isUpdate && R.cursor !== R.slots.length) {
      throw new Error(`假 React：這次 render 呼叫了 ${R.cursor} 個 hook，上一次是 ${R.slots.length} 個。`);
    }
    // 模擬 VideoAvatar 掛上／卸下 <video>
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
  if (options.strict) replayEffectsForStrictMode();

  return {
    handle,
    stage: (): AvatarStageHandle => {
      if (!handle.current) throw new Error("imperative handle 還沒掛上（或已經卸載）");
      return handle.current;
    },
    /** 這個 mount 的（假）session */
    session: (): FakeStageSession => {
      const last = sessions.at(-1);
      if (!last) throw new Error("元件沒有建 session");
      return last;
    },
    view: () => {
      const video = findByType(tree, VideoAvatarMock);
      return {
        video: video !== null,
        videoVisible: video?.props.visible === true,
        monogram: findByType(tree, DigitalAvatarMock) !== null,
      };
    },
    /** 父層用新的 props 重繪 */
    rerender: (next: Partial<StageProps>) => {
      Object.assign(props, next);
      R.render?.();
    },
    unmount: unmountRoot,
  };
}

beforeEach(() => {
  vi.resetModules();
  R.slots = [];
  R.cursor = 0;
  R.layout = [];
  R.passive = [];
  R.scheduled = false;
  R.renders = 0;
  R.render = null;
  tree = null;
  videoRefSeen = null;
  sessions.length = 0;
  resetNet();
  docListeners.clear();
  winListeners.clear();
  fakeDocument.visibilityState = "visible";

  vi.useFakeTimers({ toFake: FAKE_TIMERS });
  // 不吃開發者機器上的設定：沒指定 provider 的頁面（/chat）一律照正式站的預設（monogram）
  vi.stubEnv("NEXT_PUBLIC_AVATAR_PROVIDER", undefined);
  installNetworkTraps();
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: Listener) => listen(winListeners, type, fn),
    removeEventListener: (type: string, fn: Listener) => void winListeners.get(type)?.delete(fn),
  });
});

afterEach(() => {
  R.render = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  expectNoUnexpectedNetwork();
});

const LIVE: Partial<StageProps> = { provider: "heygen", autoStart: true, poster: "/p.jpg" };

describe("AvatarStage 接線（假 session）", () => {
  it("(a) session 一個 mount 只建一次：setVideoReady、setProvider、父層換 props 觸發的重繪都不會重建", async () => {
    const { session, rerender } = await mount(LIVE);
    expect(sessions).toHaveLength(1);
    session().options.ui.setVideoReady(true);
    await flush();
    session().options.ui.setProvider("monogram");
    await flush();
    rerender({ state: "speaking" });
    expect(R.renders).toBeGreaterThanOrEqual(4);
    expect(sessions).toHaveLength(1);
    // 重繪也不可以重跑掛載 effect：它的 cleanup 是 session.unmount()，會把正在用的 driver destroy 掉
    expect(methods(session())).toEqual(["mount", "autoStart"]);
  });

  it("(b) 掛載呼叫 session.mount()、卸載呼叫 session.unmount()；卸載時 handle 清成 null；沒開 autoStart 就不啟動", async () => {
    const { session, handle, unmount } = await mount({ provider: "heygen", poster: "/p.jpg" });
    expect(methods(session())).toEqual(["mount"]);
    expect(handle.current).not.toBeNull();
    unmount();
    expect(methods(session())).toEqual(["mount", "unmount"]);
    expect(handle.current).toBeNull();
  });

  it("(c) StrictMode 式 effect 重播（mount→cleanup→mount）：session 仍只有一個；mount 與 autoStart 各重播一次、監聽器不重複、handle 照樣接上", async () => {
    const { session, stage } = await mount(LIVE, { strict: true });
    expect(sessions).toHaveLength(1);
    expect(methods(session())).toEqual(["mount", "autoStart", "unmount", "mount", "autoStart"]);
    expect(session().autoStartCancels).toBe(1);
    expect(listenerCount()).toBe(2);
    hide();
    expect(session().calls.filter((c) => c.method === "teardown")).toHaveLength(1);
    const p = stage().prepare({ unmute: true });
    expect(p).toBe(session().prepareResult);
  });

  it("(d) visibilitychange 變 hidden → teardown(\"切到背景分頁\")；變回 visible 不動；pagehide → teardown(\"離開頁面\")", async () => {
    const { session } = await mount(LIVE);
    hide();
    expect(session().calls.at(-1)).toEqual({ method: "teardown", args: ["切到背景分頁"] });
    const count = session().calls.length;
    show();
    expect(session().calls).toHaveLength(count);
    leavePage();
    expect(session().calls.at(-1)).toEqual({ method: "teardown", args: ["離開頁面"] });
  });

  it("(d) 只在需要影像時監聽：換成 monogram 之後移除，卸載時也移除", async () => {
    const first = await mount(LIVE);
    expect(listenerCount()).toBe(2);
    first.session().options.ui.setProvider("monogram");
    await flush();
    expect(listenerCount()).toBe(0);
    const count = first.session().calls.length;
    hide();
    leavePage();
    expect(first.session().calls).toHaveLength(count);
    first.session().options.ui.setProvider("heygen");
    await flush();
    expect(listenerCount()).toBe(2);
    first.unmount();
    expect(listenerCount()).toBe(0);
  });

  it("(d) monogram 頁面（/chat：沒指定 provider）從頭就不監聽", async () => {
    const { session } = await mount({ size: "sm" });
    expect(listenerCount()).toBe(0);
    hide();
    leavePage();
    expect(methods(session())).toEqual(["mount"]);
  });

  it("(e) handle 每個方法都同步轉給 session：參數、回傳值原樣；prepare 在 return 之前就已經呼叫到；handle 一個 mount 內不換", async () => {
    const { session, stage, handle } = await mount(LIVE);
    const first = handle.current;

    const result = stage().prepare({ unmute: true });
    expect(session().calls.at(-1)).toEqual({ method: "prepare", args: [{ unmute: true }] });
    expect(result).toBe(session().prepareResult);
    void stage().prepare();
    expect(session().calls.at(-1)).toEqual({ method: "prepare", args: [undefined] });

    expect(stage().push("半")).toBeUndefined();
    expect(session().calls.at(-1)).toEqual({ method: "push", args: ["半"] });
    expect(stage().finish("整段")).toBeUndefined();
    expect(session().calls.at(-1)).toEqual({ method: "finish", args: ["整段"] });
    expect(stage().stop()).toBeUndefined();
    expect(session().calls.at(-1)).toEqual({ method: "stop", args: [] });
    expect(stage().unlockAudio?.()).toBeUndefined();
    expect(session().calls.at(-1)).toEqual({ method: "unlockAudio", args: [] });
    expect(stage().reportActivity()).toBeUndefined();
    expect(session().calls.at(-1)).toEqual({ method: "reportActivity", args: [] });

    // 見 stage-session.ts 檔頭差異 ③：videoReady 變了也不換 handle
    session().options.ui.setVideoReady(true);
    await flush();
    expect(handle.current).toBe(first);
  });

  it("(f) ui 回呼改 state → 畫面跟著變；getVideo 讀的是 VideoAvatar 的 videoRef", async () => {
    const { session, view } = await mount(LIVE);
    expect(view()).toEqual({ video: true, videoVisible: false, monogram: false });
    expect(session().options.getVideo()).toBe(fakeVideo);

    session().options.ui.setVideoReady(true);
    await flush();
    expect(view()).toEqual({ video: true, videoVisible: true, monogram: false });

    session().options.ui.setVideoReady(false);
    session().options.ui.setProvider("monogram");
    await flush();
    expect(view()).toEqual({ video: false, videoVisible: false, monogram: true });
    expect(session().options.getVideo()).toBeNull();
  });

  it("(g) callback props 換成新函式之後，session 呼叫到的是最新那個", async () => {
    const seen: string[] = [];
    const { session, rerender } = await mount({
      ...LIVE,
      onSpeakingChange: (speaking) => seen.push(`舊 speaking ${speaking}`),
      onAudioAvailableChange: (available) => seen.push(`舊 available ${available}`),
      onTeardown: () => seen.push("舊 teardown"),
      onSpeechFailed: () => seen.push("舊 speechFailed"),
    });
    const callbacks = session().options.callbacks;
    rerender({
      onSpeakingChange: (speaking) => seen.push(`新 speaking ${speaking}`),
      onAudioAvailableChange: (available) => seen.push(`新 available ${available}`),
      onTeardown: () => seen.push("新 teardown"),
      onSpeechFailed: () => seen.push("新 speechFailed"),
    });
    callbacks.onSpeakingChange(true);
    callbacks.onAudioAvailableChange?.(false);
    callbacks.onTeardown?.();
    callbacks.onSpeechFailed?.();
    expect(seen).toEqual(["新 speaking true", "新 available false", "新 teardown", "新 speechFailed"]);
    expect(sessions).toHaveLength(1);
  });

  it("(h) autoStart：一個 mount 只啟動一次（重繪不重來），卸載時取消", async () => {
    const { session, rerender, unmount } = await mount(LIVE);
    expect(methods(session()).filter((m) => m === "autoStart")).toHaveLength(1);
    session().options.ui.setVideoReady(true);
    await flush();
    rerender({ state: "thinking" });
    expect(methods(session()).filter((m) => m === "autoStart")).toHaveLength(1);
    expect(session().autoStartCancels).toBe(0);
    unmount();
    expect(session().autoStartCancels).toBe(1);
  });

  it("(i) providerOverride 原樣傳入；正式碼不注入 createDriver；畫面初值照它", async () => {
    const { session, view } = await mount({ provider: "heygen", poster: "/p.jpg" });
    expect(session().options.providerOverride).toBe("heygen");
    expect(session().options.createDriver).toBeUndefined();
    expect(view()).toMatchObject({ video: true, monogram: false });
  });

  it("(i) 沒指定 provider（/chat）：傳 undefined，畫面初值照 resolveProvider（正式站是 monogram）", async () => {
    const { session, view } = await mount({ size: "sm" });
    expect(session().options.providerOverride).toBeUndefined();
    expect(view()).toMatchObject({ video: false, monogram: true });
  });
});
