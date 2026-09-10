"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import ChibiAvatar from "@/components/avatar/ChibiAvatar";
import type { AvatarStageHandle } from "@/components/avatar/AvatarStage";
import { LipSyncPlayer } from "@/lib/avatar/lipsync-player";
import type { Viseme } from "@/lib/avatar/lipsync";
import { trace } from "@/lib/trace";

/**
 * `AvatarStage` 的 Q 版替身：同一個 `AvatarStageHandle`，換掉後面整條管線。
 *
 * `/live4` 用它，`/live`、`/live2`、`/live3` 仍然走 `AvatarStage`（HeyGen）。
 * 兩邊共用 `LiveStage`：錄音、STT、chat、字幕、揭露、限流、錯誤文案完全一樣，
 * 差別只在「誰把答案唸出來、畫面上動的是什麼」。
 *
 * ## 為什麼是實作同一個介面，而不是複製一份 LiveStage
 *
 * `LiveStage` 有 700 行，而它碰 avatar 的地方只有 `stageRef` 上的五支方法
 * （而且實際只呼叫其中四支，見下面 `push` 的說明）。複製一份的代價是
 * 「兩份錄音狀態機、兩份揭露、兩份錯誤文案」，其中任何一份先修好都會漂移。
 *
 * ## 跟 HeyGen 版的差別
 *
 * | | AvatarStage（HeyGen） | ChibiStage |
 * |---|---|---|
 * | 影像 | 串流虛擬人，**按 session 計費** | 分層立繪，只有 `/api/tts` 要錢 |
 * | 聲音 | driver 內部去打 `/api/tts` | 這裡直接打 `/api/tts` |
 * | 對嘴 | 對方的模型做 | `LipSyncPlayer` 從 PCM 算 |
 * | 臉部對位 | 要量（`poses.ts` 記著量錯過一次） | 不需要，嘴型圖層本來就在立繪上 |
 * | 閒置保活 | 需要（有計費中的串流） | 不需要，沒有 session |
 *
 * 🔴 **浮水印不是裝飾。** `/live` 那條路上「AI 生成影像」是掛在
 * `AvatarStage`（poster 階段）與 `VideoAvatar`（串流階段）身上的，
 * `LiveStage` 自己不負責——所以換掉 avatar 就等於把那道法定揭露一起拆掉。
 * 這裡照樣提供，位置與樣式跟那兩份一致（`right-3 top-16`，理由見 VideoAvatar 註解）。
 * 它在這一頁**更**需要：畫面上不再是她本人的臉，而是一個 AI 生成的 Q 版形象。
 */

/**
 * 靜默多久才算「她講完了」。
 *
 * 🔴 不可以直接用 `player.isPlaying`，也不可以直接用 `level > 0`：
 *
 * - `isPlaying` 在**串流讀完**就變成 false，不是在聲音播完。ElevenLabs 的生成
 *   速度約 2.25 倍實時，所以一段 20 秒的話大約 9 秒就收完了，那之後還有
 *   十幾秒的音訊排在播放圖上等著出聲。只看它的話她會在講到一半時被判定講完。
 * - `level > 0` 會在**句讀的停頓**掉到 0。直接用它，`speaking` 會在一句話中間
 *   反覆 true/false，而 `LiveStage.press()` 是靠 `speaking` 決定要不要打斷她的
 *   ——剛好在停頓那一格按下去，打斷就不會發生，她會蓋著訪客的錄音繼續講。
 *
 * 700ms 比正常句讀停頓長（`lipsync.ts` 的 RELEASE 曲線幾百毫秒內就閉嘴），
 * 又短到講完之後不會讓按鈕卡在「她還在講」的狀態太久。
 */
const SILENCE_HOLD_MS = 700;

/**
 * 立繪的長寬比，用來把人物「以高度為準」撐滿畫面。
 *
 * ⚠️ 必須跟 `ChibiAvatar` 的 `FIGURE_ASPECT` 一致。那個常數沒有 export
 * （它是那個元件的內部細節），所以這裡只能抄一份。換美術素材時
 * `scripts/build-chibi-assets.py` 會印出新的比例，**兩處要一起改**——
 * 不一致的症狀是人物底下多出一條空隙，或腳被切掉一截。
 */
const FIGURE_ASPECT = "382 / 672";

interface Props {
  /**
   * 她正在講話嗎。語意跟 `AvatarStage` 的同名 prop 一致：
   * 呼叫端拿它推導畫面狀態，也拿它決定「再按一次按鈕是不是打斷」。
   */
  onSpeakingChange(speaking: boolean): void;
  /**
   * 這一段話沒有聲音（多半是 `/api/tts` 失敗）。
   * ⚠️ 答案文字已經在畫面上了，所以這不是「這一輪失敗」——
   * 沒有人接這個回呼的話，訪客得到的是完全沉默 ＋ 零解釋。
   */
  onSpeechFailed?(): void;
}

const ChibiStage = forwardRef<AvatarStageHandle, Props>(function ChibiStage(
  { onSpeakingChange, onSpeechFailed },
  ref
) {
  const [viseme, setViseme] = useState<Viseme>("closed");
  const [level, setLevel] = useState(0);
  /** 真的有聲音在播（含遲滯，見 SILENCE_HOLD_MS） */
  const [audible, setAudible] = useState(false);
  /** `/api/tts` 的請求還在飛 */
  const [pending, setPending] = useState(false);

  const playerRef = useRef<LipSyncPlayer | null>(null);
  /** 正在飛的那一次合成請求。打斷時要連它一起取消 */
  const requestRef = useRef<AbortController | null>(null);
  /** 最後一次「確定有聲音」的時刻（`performance.now()` 座標） */
  const lastVoiceAtRef = useRef(Number.NEGATIVE_INFINITY);

  // callback 放進 ref：呼叫端每次 render 換新函式時，不要跟著重建 rAF 迴圈
  const speakingCb = useRef(onSpeakingChange);
  speakingCb.current = onSpeakingChange;
  const speechFailedCb = useRef(onSpeechFailed);
  speechFailedCb.current = onSpeechFailed;

  /**
   * 拿到 player，沒有就建一個。
   *
   * ⚠️ 必須是**同步**的，而且不能在 render 期間建。
   * `LipSyncPlayer` 的建構子刻意不開 `AudioContext`（見該檔註解），
   * 所以在事件處理裡現建完全沒問題。
   */
  const ensurePlayer = useCallback((): LipSyncPlayer => {
    let player = playerRef.current;
    if (!player) {
      player = new LipSyncPlayer();
      playerRef.current = player;
    }
    return player;
  }, []);

  /**
   * 每一幀去問一次現在該是哪個嘴型。
   *
   * ⚠️ 只在值真的變了才 setState。rAF 是 60Hz，而分析器只有 25Hz——
   * 無條件 setState 等於每秒 60 次重繪換 25 次有意義的變化。
   */
  useEffect(() => {
    let raf = 0;
    let lastViseme: Viseme = "closed";
    let lastLevel = 0;
    let lastAudible = false;

    const tick = () => {
      const player = playerRef.current;
      if (player) {
        const state = player.currentViseme();
        if (state.viseme !== lastViseme) {
          lastViseme = state.viseme;
          setViseme(state.viseme);
        }
        if (Math.abs(state.level - lastLevel) > 0.02) {
          lastLevel = state.level;
          setLevel(state.level);
        }

        const now = performance.now();
        if (player.isPlaying || state.level > 0) lastVoiceAtRef.current = now;
        const audibleNow = now - lastVoiceAtRef.current < SILENCE_HOLD_MS;
        if (audibleNow !== lastAudible) {
          lastAudible = audibleNow;
          setAudible(audibleNow);
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  /**
   * 回報「她正在講話」。
   *
   * ⚠️ 請求在飛的時候就要回報 true，不要等第一個音出來。
   * `lib/avatar/heygen.ts:133` 對同一件事留了實測紀錄：`/api/chat` 結束到她真的
   * 出聲之間有 2.7 秒，那段時間如果回報 false，畫面會是「答案文字出現、她一臉
   * 閒著不動」。而且 `LiveStage.press()` 是靠這個布林決定要不要 `stop()` 打斷她的
   * ——這段空窗回報 false 的話，訪客在合成中按下按鈕不會取消那一次合成，
   * 3 秒後她會蓋著訪客的錄音開始講。
   */
  useEffect(() => {
    speakingCb.current(audible || pending);
  }, [audible, pending]);

  /** 卸載：停迴圈（上面的 effect 自己會 cancel）、收掉請求與 AudioContext */
  useEffect(() => {
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
      // ⚠️ 一定要 dispose。Chrome 對同一個分頁的 AudioContext 數量有上限（約 6 個），
      // 反覆進出這一頁就會開不出新的，症狀是嘴在動但沒有聲音。
      playerRef.current?.dispose();
      playerRef.current = null;
    };
  }, []);

  const stop = useCallback(() => {
    // 請求也要取消。只 stop() 播放的話，還在飛的那一次合成會在幾秒後
    // 到達並開始播——訪客已經在講下一題了。
    requestRef.current?.abort();
    requestRef.current = null;
    setPending(false);
    lastVoiceAtRef.current = Number.NEGATIVE_INFINITY;
    playerRef.current?.stop();
  }, []);

  const finish = useCallback(
    (fullText: string) => {
      const text = fullText.trim();
      // 空字串送去 `/api/tts` 只會換到一個 400。這裡沒有東西要唸，
      // 也不該回報「聲音失敗」——那會在畫面上多一句沒有指涉對象的提示。
      if (!text) return;

      // 上一段還在飛就先收掉。`player.play()` 內部也會 stop()，但它管不到 fetch。
      requestRef.current?.abort();
      const request = new AbortController();
      requestRef.current = request;

      const player = ensurePlayer();
      setPending(true);
      trace("向 /api/tts 要克隆語音", `${text.length} 字`);

      void (async () => {
        try {
          const response = await fetch("/api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // body 的形狀跟 `app/api/tts/route.ts` 一致：`{ text: string }`
            body: JSON.stringify({ text }),
            signal: request.signal,
          });
          if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status}`);
          }
          // ⚠️ 直接把 body 餵進去，不要先 await 成完整 buffer——
          // 那會把首字延遲從 3.6 秒變成 12.9 秒（見 lipsync-player.ts 檔頭）。
          await player.play(response.body);
        } catch (error) {
          // 被打斷不是失敗。訪客自己按的按鈕，畫面上不需要任何解釋。
          if (request.signal.aborted) return;
          trace(
            "Q 版語音失敗",
            error instanceof Error ? error.message : String(error),
            "error"
          );
          player.stop();
          speechFailedCb.current?.();
        } finally {
          // ⚠️ 要比對是不是自己那一次。新的一段已經開始的話，
          // 這裡把 pending 清成 false 會讓新的那一段少掉「合成中」的狀態。
          if (requestRef.current === request) {
            requestRef.current = null;
            setPending(false);
          }
        }
      })();
    },
    [ensurePlayer]
  );

  useImperativeHandle(
    ref,
    () => ({
      /**
       * 🔴 `prime()` 必須在**使用者手勢的呼叫堆疊裡、任何 await 之前**呼叫，
       * 所以這一支刻意不是 async：它同步做完 prime 才回傳一個已 resolve 的 promise。
       *
       * ✅ 呼叫端確認過：`LiveStage` 唯一呼叫這支的地方是 `press()`
       * （components/live/LiveStage.tsx:437 的 `void stageRef.current?.prepare({ unmute: true })`），
       * 而 `press()` 從按鈕的 `onClick` → `toggle()` → `press()` 一路同步下來，
       * 第一個 `await` 是它後面的 `recorderRef.current?.start()`。也就是這一行確實
       * 還在手勢裡。⚠️ 要在 `press()` 裡加 await 的話，必須加在這一行**之後**。
       *
       * 沒帶 `unmute` 就什麼都不做：那代表呼叫端不在手勢裡（`AvatarStage` 的
       * autoStart 就是這樣呼叫的）。那時候開 `AudioContext` 只會開出一個永遠
       * suspended 的 context（Safari 尤其明確），症狀是**嘴在動但完全沒有聲音**，
       * 而且沒有錯誤，只有 console 一行 autoplay 警告。
       */
      prepare: (options?: { unmute?: boolean }) => {
        if (options?.unmute) ensurePlayer().prime();
        return Promise.resolve();
      },

      /**
       * 逐字送出。**刻意是空的。**
       *
       * 兩個理由，缺一都不足以留白：
       * 1. `LiveStage` 根本不呼叫它——答案是整段拿到之後走 `finish()`。
       *    （HeyGen 版留著這支是為了 `/chat` 那條路。）
       * 2. 就算呼叫了，這一側也沒有對應的東西可做：HeyGen 是把字逐段送給
       *    串流虛擬人邊收邊講，而 ElevenLabs 是**整句合成**——逐字送等於
       *    每個字開一次合成請求，既貴又會把一句話切成一格一格的。
       */
      push: () => {},

      finish,
      stop,

      /**
       * 回報「使用者還在」。**刻意是空的。**
       *
       * HeyGen 版需要它，是因為那邊有一條**計費中**的串流掛著閒置計時器
       * （75 秒沒互動就收線），而訪客講話那 45 秒一個字都不會送進來。
       * Q 版沒有 session、沒有連線、也沒有任何按時間計費的東西要保活，
       * 所以這裡沒有事情可做——這正是換掉 HeyGen 換到的東西之一。
       */
      reportActivity: () => {},
    }),
    [ensurePlayer, finish, stop]
  );

  const speaking = audible || pending;

  return (
    <div className="absolute inset-0 overflow-hidden">
      {/*
        背景。**CSS 漸層，不是圖檔**，而且刻意不假裝是任何真實地點。

        🔴 這是 `/live3` 那四輪修圖量出來的結論（見 app/live3/page.tsx 檔頭）：
        平塗的人物放進有方向性自然光的真實場景，不match在人物的**內部**，
        去背怎麼修都到不了。這一頁的人物是卡通線稿，比那張全身圖更平，
        配照片只會更糟。腦袋一旦不把背景當照片看，就不會去比對光線對不對。

        ⚠️ 下半段刻意往暗收，這對應 `/live3` 那張背景板「底部收暗是做在圖檔上」
        的那一段：`LiveStage` 底部那條 `from-ink via-ink/85 to-transparent` 是字幕
        與法定揭露可讀性的唯一保障，不可以為了多露一點背景而調淡它，所以背景
        自己要先暗下來。

        🔴 色標不是挑好看的，是算過的。把這組漸層（含上面兩層光暈）疊上那條
        字幕帶之後，白字對比（1280×860、有問有答時的排版）：

        ```
                              /live4   /live3 的背景板（最亮 180）
          SITE_NOTICE          17.3         16.4
          按鈕                 17.1         15.0
          ANSWER_DISCLAIMER    16.3         13.7
          答案                 13.9         10.3
          「你問」泡泡上緣        4.8          3.4   ← 最吃緊的一列
        ```

        每一列都比現有的 `/live3` 好，法定揭露那兩列都在 AAA（7:1）之上。
        ⚠️ 最吃緊的是「你問」泡泡的上緣：它在字幕帶最上面，那裡 ink 只有 α≈0.37，
        而它自己的 `bg-white/12` 又會把底色提亮。要往下調亮度色標之前先算這一列。
        （矮視窗 700px 時它會掉到 3.9，`/live3` 在同樣條件下是 3.4。）

        ⚠️ `/live3` 註解裡「大面積漸層要加 ±3.2 階雜訊」那條**不適用**：那是
        WebP 量化造成的色帶，這裡是瀏覽器自己畫的漸層，不經過那道量化。
      */}
      <div
        className="absolute inset-0"
        style={{
          background: [
            // 人物正後方的柔光暈，白色的核
            "radial-gradient(58% 42% at 50% 30%, rgba(255,255,255,.58) 0%, rgba(255,255,255,0) 68%)",
            // 外圈用品牌淺紫（--brand-soft #c3b7e4）散開，讓光暈不會是一顆白球
            "radial-gradient(80% 64% at 50% 38%, rgba(195,183,228,.5) 0%, rgba(195,183,228,0) 74%)",
            // 底：薰衣草色票由上往下走，下半段收暗給字幕帶
            [
              "linear-gradient(to bottom",
              "#ede9f6 0%", // --brand-wash
              "#dbd3ea 26%", // --bg
              "#cec5e1 42%", // --bg-tint 再暗一階
              "#a599c2 56%",
              "#6a6087 72%",
              "#342d45 88%",
              "#221d2e 100%)",
            ].join(", "),
          ].join(", "),
        }}
      />

      {/*
        人物：以高度為準填滿、水平置中。

        ⚠️ 外框用 `aspect-ratio` 由高度換算寬度，不是給 ChibiAvatar 一個
        `height: 100%` 的 class——那個元件的寬高是寫在 inline style 上的
        （`width: 100%` ＋ 它自己的 aspectRatio），class 蓋不過 inline style。
      */}
      <div className="absolute inset-0 flex items-end justify-center">
        <div style={{ height: "100%", aspectRatio: FIGURE_ASPECT }}>
          <ChibiAvatar viseme={viseme} level={level} speaking={speaking} />
        </div>
      </div>

      {/*
        🔴 常駐揭露，不是裝飾。

        `/live` 那條路上這條浮水印是掛在 `AvatarStage`（poster 階段）與
        `VideoAvatar`（串流階段）身上的，`LiveStage` 自己沒有負責——所以換掉
        avatar 元件就等於把它一起拆掉。`/about-ai` 與
        `content/knowledge/07-about-this-site.md` 都對訪客寫著「畫面上永遠有
        『AI 生成影像』的標記，那個標記不會關掉」，那是一句承諾。

        🔴 這一頁比 `/live` 更需要它：那邊畫面中央至少是她**本人的臉**（真實
        攝影或依其生成的對嘴影像），這裡整個人物都是 AI 生成的 Q 版形象草案。

        ⚠️ `right-3 top-16` 與樣式跟那兩份逐字一致。`top-16` 不是隨手抓的：
        `LiveStage` 最上方有一條身分列，貼 `top-3` 會被它蓋掉——實測手機版就是
        這樣，而「浮水印看不見」等於這道護欄不存在。
      */}
      <span className="pointer-events-none absolute right-3 top-16 rounded-full bg-ink/80 px-3 py-1 text-[11px] font-bold tracking-wide text-white backdrop-blur-sm">
        AI 生成影像
      </span>
    </div>
  );
});

export default ChibiStage;
