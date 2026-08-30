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

/**
 * monogram  圓形「李」字標記 ＋ 瀏覽器 TTS。這是**備援**，不是主要呈現：
 *           零成本、不連外，是其他 driver 掛掉時的退路，所以永遠不會被移除。
 *           ⚠️ 它刻意長得不像人臉——備援畫面要讓人一眼看出串流沒接上，
 *           理由寫在 components/avatar/DigitalAvatar.tsx 的檔頭。
 * mock      假時序、不發聲、不連外。用來把整個 UI（載入、淡入、閒置退場、
 *           失敗降級、浮水印）做完並測完，完全不需要任何帳號或額度。
 * heygen    真的即時串流虛擬人：老師的授權影像 ＋ 克隆聲音 ＋ 即時對嘴。
 *           **已經實作並上線**，是站上的主要呈現（/live 直接指定它）。
 *           實作在 lib/avatar/heygen.ts，走 api.liveavatar.com。
 */
export type AvatarProvider = "monogram" | "mock" | "heygen";

export interface AvatarDriverHooks {
  /** driver 開始／停止發聲。呼叫端拿它餵 deriveAvatarState。 */
  onSpeakingChange(speaking: boolean): void;
  /**
   * 不可恢復的錯誤。收到之後呼叫端應該立刻降級回 monogram，
   * 而且不可以再呼叫這個 driver 的任何方法。
   *
   * 這是整個 driver 介面存在的主要理由：數位人死掉時，
   * 網站要退化成「還能用的文字聊天」，而不是白畫面。
   */
  onFatal(error: Error): void;
  /**
   * 伺服器允許這個 session 活多久（秒）。metered driver 在拿到 token 之後回報。
   *
   * ⚠️ 存在的理由是不要有兩套數字。AvatarStage 原本自己寫死 5 分鐘硬上限，
   * 但真正說了算的是伺服器的 max_session_duration（帳本預設 180 秒）。
   * 客戶端的上限比伺服器長，症狀就是「她講到一半突然消失，畫面沒有任何解釋」——
   * 文字聊天是短促的所以看不出來，全螢幕的多輪對話一定會撞到。
   */
  onSessionLimit?(seconds: number): void;
  /**
   * 計費 session 開好了，這是它的 id。
   *
   * ⚠️ 呼叫端要留著它，收線時回報給 /api/avatar-session/close——
   * 那是帳本拿到**真實時長**的唯一路徑。沒有它，每一筆都只能以單次上限估算，
   * 而上限是 3 分鐘，實際多半遠低於此，帳會嚴重高估。
   */
  onSessionOpened?(sessionId: string): void;
  /**
   * 影像還活著、但這一段話發不出聲音。
   *
   * ⚠️ 跟 `onFatal` 要分開：onFatal 會整個降級回 monogram，
   * 但語音失敗時那張臉還在、下一題也可能就正常了，降級是過度反應。
   *
   * ⚠️ 這個回呼**必須**有人接。LITE 模式沒有 `repeat` 的實作——
   * 指令送得出去，聲音不會出來（實測她的聲軌峰值 0.0001）。
   * 沒有它，TTS 一失敗訪客看到的就是「按了、講了、她不理我」，
   * 而且畫面上沒有任何線索。那正是使用者連續回報的症狀。
   */
  onSpeechFailed?(): void;
}

/**
 * 所有 driver 都自己擁有音訊輸出，呼叫端不可以另外再開一路瀏覽器 TTS——
 * 否則會有兩個聲音疊在一起講同一段話。這件事靠介面本身保證：
 * ChatPanel 拿不到 Speaker，只拿得到 driver。
 *
 * ⚠️ 任何一個方法都不可以把例外丟給呼叫端。錯誤一律走 hooks.onFatal。
 */
export interface AvatarDriver {
  readonly provider: AvatarProvider;
  /** 需不需要一個 <video> 才能運作。monogram 是 false。 */
  readonly needsVideo: boolean;
  /**
   * 這個 driver 活著就在花錢／佔用遠端 session。
   *
   * 決定要不要掛閒置退場、切到背景就收、離開頁面就收、單次硬上限那一整套。
   * 刻意跟 needsVideo 分開：兩者現在剛好一致，但意思不同，
   * 而把 monogram 誤判成 metered 會讓它閒置 90 秒後啞掉——那是純粹的 bug。
   */
  readonly metered: boolean;
  /**
   * prepare() 之後才有意義：這個 driver 在「這台裝置上」到底發不發得出聲音。
   * monogram 會因為裝置沒有中文語音而是 false，這時 UI 要顯示「此裝置無中文語音」。
   */
  readonly audioAvailable: boolean;

  /**
   * 必須在使用者手勢的呼叫堆疊裡呼叫（自動播放政策），而且 heygen 從這裡開始計費。
   * 冪等：重複呼叫只會生效一次。
   */
  prepare(video: HTMLVideoElement | null): Promise<void>;

  /**
   * 串流中的增量文字。等整段答案才開口的 driver（heygen）會直接忽略它——
   * 理由寫在 speakableAnswer 的註解裡。
   */
  push(delta: string): void;

  /** 串流結束，傳入**完整**答案。逐句朗讀的 driver 此時只需把殘句唸完。 */
  finish(fullText: string): void;

  /** 立刻閉嘴，但保留 session。冪等。 */
  stop(): void;

  /** 釋放資源（heygen：關掉計費中的 session）。冪等，呼叫後不可再用。 */
  destroy(): Promise<void>;
}

/**
 * 決定「真正要唸出來的是哪段字」。
 *
 * lib/answer-guard.ts 命中封鎖清單時會**停止輸出剩餘文字**，然後路由在後面
 * 追加 GUARDED_REPLY。⚠️ 注意它**收不回已經 flush 出去的字**（60 字滾動緩衝，
 * 在那之前的都已經在瀏覽器裡了）。畫面上使用者看到的是被截斷的半句＋婉拒，
 * 但如果我們照著整段唸，就會把「系統事後判定為不該說」的那段唸出去。
 *
 * 今天那是合成音，還只是尷尬；換成老師本人的臉和聲音之後，
 * 那就是**她的臉、她的聲音，說出一句系統認定她不該說的話**。
 *
 * 所以規則很簡單：結尾是 GUARDED_REPLY 就只講 GUARDED_REPLY。
 */
export function speakableAnswer(fullText: string, guardedReply: string): string {
  if (!guardedReply) return fullText;
  return fullText.trimEnd().endsWith(guardedReply) ? guardedReply : fullText;
}
