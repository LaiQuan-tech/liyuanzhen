export type AvatarState = "idle" | "thinking" | "speaking";

/**
 * 由兩個正交的事實推導出頭像狀態——刻意「不」用一個 useState 去記 avatarState。
 *
 * 原本的寫法是 send() 寫一次、TTS 的 onState 再寫一次，兩個 writer 搶同一個
 * state，然後用 `prev === "thinking" ? prev : …` 這種 guard 去防，結果是死鎖：
 * 一旦進入 thinking 就再也出不來，頭像永遠停在「正在查資料…」，
 * 而且 gate 在 speaking 上的「停止」按鈕永遠不會出現。
 *
 * 正在講話優先於正在查資料：串流還沒結束但已經開口時，要顯示「回答中」。
 */
export function deriveAvatarState(speaking: boolean, busy: boolean): AvatarState {
  if (speaking) return "speaking";
  if (busy) return "thinking";
  return "idle";
}
