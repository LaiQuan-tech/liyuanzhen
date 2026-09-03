import type { AvatarState } from "@/lib/avatar";

/**
 * /live 的狀態推導。純函式、無 React、無 DOM，所以測得到。
 *
 * ⚠️ 照 `deriveAvatarState`（lib/avatar/types.ts）的既有紀律做：
 * **保留正交的事實，狀態用推導的**，不要另外開一個 useState 去記它。
 * 那邊的註解記著為什麼——兩個 writer 搶同一個 state 會死鎖，
 * 一旦進入 thinking 就再也出不來，症狀是頭像永遠卡在「正在查資料…」。
 *
 * /live 的 writer 比 /chat 更多（錄音、辨識、生成、朗讀四段），
 * 所以這條紀律在這裡更重要，不是更不重要。
 */

export type LiveState =
  /** 待機。點一下按鈕就開始錄音 */
  | "idle"
  /** 麥克風開著，訪客正在講 */
  | "recording"
  /** 音訊送去轉逐字稿 */
  | "transcribing"
  /** 逐字稿送去 RAG ＋ 生成 */
  | "thinking"
  /** 她正在講話 */
  | "speaking"
  /** 這一輪出錯了，畫面顯示容錯文案 */
  | "error";

/** 一輪對話跑到哪了。錄音不在裡面——那是獨立的事實，見下方說明。 */
export type TurnPhase = "idle" | "transcribing" | "thinking";

export interface LiveFacts {
  /** 麥克風正在收音 */
  recording: boolean;
  /** 伺服器往返跑到哪一段 */
  phase: TurnPhase;
  /** driver 回報她正在發聲 */
  speaking: boolean;
  /** 這一輪失敗了。下一次點按鈕會清掉 */
  errored: boolean;
}

/**
 * 優先序是有意義的，不是隨手排的：
 *
 * 1. `recording` 最大——訪客點下按鈕的當下，畫面必須立刻回應。
 *    她還在講話時按下去就是要打斷她，這時顯示「回答中」是錯的。
 * 2. `speaking` 贏過 `phase`——串流還沒結束但她已經開口時要顯示「回答中」，
 *    跟 deriveAvatarState 同一個理由。
 * 3. `errored` 排在最後面：它是上一輪的殘留，任何新的活動都該蓋過它。
 */
export function deriveLiveState({ recording, phase, speaking, errored }: LiveFacts): LiveState {
  if (recording) return "recording";
  if (speaking) return "speaking";
  if (phase === "transcribing") return "transcribing";
  if (phase === "thinking") return "thinking";
  if (errored) return "error";
  return "idle";
}

/**
 * 餵給 `<AvatarStage state={...}>` 的值。
 * AvatarState 只有三檔，錄音與辨識都對應到「還沒開口」。
 *
 * ⚠️ `recording` 對應到 `idle` 而不是 `thinking`：訪客講話的時候
 * 她應該看起來在聽，不是在查資料。真正的聆聽姿態靠 SDK 的
 * `startListening()`，那是另一條路。
 */
export function avatarStateFor(state: LiveState): AvatarState {
  if (state === "speaking") return "speaking";
  if (state === "transcribing" || state === "thinking") return "thinking";
  return "idle";
}

/**
 * 現在可不可以開始錄音。
 *
 * ⚠️ 講話中**可以**按——那是打斷，是刻意允許的。
 * Sunny 的展場版沒有做打斷，實際症狀是兩段語音重疊。
 * 唯一擋住的是「上一輪還在伺服器往返中」，因為那時候按下去
 * 會出現兩個並行的請求，而回應順序無法保證。
 */
export function canStartRecording(state: LiveState): boolean {
  return state === "idle" || state === "speaking" || state === "error";
}

/** 這個狀態下，麥克風是不是開著的。用來決定按鈕的顏色與文字。 */
export function isRecording(state: LiveState): boolean {
  return state === "recording";
}

/** 伺服器往返中。這段時間按鈕要顯示為不可用，而不是假裝可以按。 */
export function isBusy(state: LiveState): boolean {
  return state === "transcribing" || state === "thinking";
}

/**
 * 兩次點擊之間的最小間隔。
 *
 * 🔴 切換式獨有的失敗模式：緊張的人會連點兩下。第二下如果被當成「送出」，
 * 得到的是一段 0.3 秒的錄音，畫面回他「沒收到聲音」——而他的動作
 * （點兩下）在按住式裡是完全正常的。所以開始後這段時間內的點擊要吞掉。
 *
 * ⚠️ 不要靠 `MIN_RECORDING_SECONDS`（0.2 秒）去擋。那一支是在**放開之後**
 * 判斷結果，擋下來的代價是一句錯誤提示；這裡是在**按下的當下**就不理它，
 * 錄音完全沒有被中斷。兩者是不同層的東西，都要有。
 */
export const TAP_DEBOUNCE_MS = 500;

/** 切換式按鈕按下去之後該做什麼。 */
export type TalkAction = "start" | "stop" | "ignore";

/**
 * 點一下說話按鈕的分派。
 *
 * 抽成純函式的理由很實際：`vitest.config.ts` 是 `environment: "node"`、
 * `include: ["**\/*.test.ts"]`，專案裡沒有 jsdom 也沒有 React Testing Library，
 * 所以 `LiveStage.tsx` 裡的任何東西**都測不到**。把判斷放在這裡，
 * 它就跟 `deriveLiveState` 一樣有窮舉測試守著。
 *
 * @param msSinceStart 錄音開始到現在幾毫秒。沒在錄音就傳 null。
 */
export function talkButtonAction(state: LiveState, msSinceStart: number | null): TalkAction {
  // 伺服器往返中。按鈕本來就 disabled，這裡是第二道——
  // disabled 只擋滑鼠與鍵盤，程式化的 click 擋不住。
  if (isBusy(state)) return "ignore";

  if (isRecording(state)) {
    if (msSinceStart !== null && msSinceStart < TAP_DEBOUNCE_MS) return "ignore";
    return "stop";
  }

  // ⚠️ 這裡保留 canStartRecording 的語意不動：speaking 可以按（打斷她是刻意允許的）。
  return canStartRecording(state) ? "start" : "ignore";
}
