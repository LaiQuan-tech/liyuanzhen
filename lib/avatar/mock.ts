import type { AvatarDriver, AvatarDriverHooks } from "./types";

/** 每個字的假朗讀時間。中文語速大約每分鐘 240 字，換算約 250ms／字。 */
const MS_PER_CHAR = 250;
/** 假的串流建立時間。刻意設得夠久，讓載入畫面與交叉淡入真的看得到。 */
const PREPARE_DELAY_MS = 1200;
/** 講太久的假等待會拖慢開發，設個上限 */
const MAX_SPEAK_MS = 6000;

/** 預設的假畫面。長得像 mock 是刻意的，見 prepare() 裡的說明。 */
const MOCK_POSTER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="960">
       <rect width="720" height="960" fill="#1a1a1a"/>
       <text x="360" y="480" font-size="48" fill="#8a8a8a"
             text-anchor="middle" font-family="sans-serif">MOCK AVATAR</text>
     </svg>`
  );

/**
 * 故障注入：只給**本機瀏覽器**驗證執行期 onFatal 的降級用（2026-09-29）。
 *
 * 用法：`NEXT_PUBLIC_AVATAR_PROVIDER=mock` 開 dev server，再開 `/live?mockFatal=prepare` 或 `?mockFatal=speak`。
 * - `prepare`：接通失敗（像 token 被拒、額度用盡）。連線期間排隊的答案會先報「聲音沒出來」。
 * - `speak`：第一則答案開始說話之後，講到一半斷線。
 *
 * 存在的理由：真的 heygen 要重現斷線得開計費 session 再拔網路；mock 以前根本不會 onFatal，
 * 降級那一整條路（「李」字、改用老師的聲音、下一次按說話解鎖）在不花錢的環境裡完全走不到。
 * ⚠️ 降級之後出聲的是 monogram，它會真的打 /api/tts（花 ElevenLabs 額度）。
 * ⚠️ 沒帶參數時行為**完全不變**；node（測試、SSR）沒有 window，一律當沒帶。
 * 正式站沒設 NEXT_PUBLIC_AVATAR_PROVIDER=mock，這支 driver 根本不會被建立，網址帶了也沒有作用。
 */
export type MockFatal = "prepare" | "speak";

/** 從網址的 query string 讀故障注入。看不懂的值一律當沒帶。 */
export function readMockFatal(search: string | undefined): MockFatal | null {
  if (!search) return null;
  try {
    const value = new URLSearchParams(search).get("mockFatal");
    return value === "prepare" || value === "speak" ? value : null;
  } catch {
    return null;
  }
}

function currentSearch(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.location?.search;
  } catch {
    return undefined;
  }
}

/**
 * 假 driver：不發聲、不連外、不計費，但**時序是真的**。
 *
 * 存在的理由是把「需要 HeyGen 帳號才能做的事」和「不需要的事」切開。
 * 版面、載入交叉淡入、解除靜音手勢、閒置退場、onFatal 降級（用 ?mockFatal= 注入，見 MockFatal）、
 * 浮水印——這些全部可以用 mock 做完並測完，一毛錢都不用花，也不佔用 LiveAvatar 的分鐘數。
 *
 * 它也是唯一能在 CI 裡跑的 driver。
 */
export function createMockDriver(hooks: AvatarDriverHooks): AvatarDriver {
  const inject = readMockFatal(currentSearch());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let prepared = false;
  let preparing = false;
  let dead = false;
  /** 跟 heygen 一樣：每個 driver 最多報一次 fatal，見 reportFatal */
  let fatalReported = false;
  /** `?mockFatal=speak` 的斷線計時器。只在第一則答案開口時排一次 */
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let spokeOnce = false;

  /**
   * 連線期間送到的答案。⚠️ mock 存在的意義是「時序是真的」，
   * 所以這個佇列一定要跟 heygen 有一模一樣的語意——
   * 少了它，mock 就會把 heygen 上真實發生過的 bug 蓋掉：
   * prepare 要 5～8 秒、一輪問答只要 2～6 秒，第一題的答案必然先到，
   * 舊版直接丟棄，症狀是每次開頁後的第一題她都不出聲。
   */
  let pendingSpeech: string | null = null;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function stopSpeaking() {
    clearTimer();
    hooks.onSpeakingChange(false);
  }

  /**
   * 跟 heygen 的 reportFatal 同一套語意（mock 的意義就是時序與語意跟 heygen 一致，否則 CI 會蓋掉 bug）：
   * 每個 driver 最多一次、destroy 之後不報；手上還沒送達的答案（排隊中、正在講）先 onSpeechFailed
   * 一次；順序是說話狀態收掉 → onSpeechFailed → onFatal。
   */
  function reportFatal(error: Error) {
    if (dead || fatalReported) return;
    fatalReported = true;
    const talking = timer !== null;
    const undelivered = pendingSpeech !== null || talking;
    pendingSpeech = null;
    if (talking) stopSpeaking();
    if (undelivered) hooks.onSpeechFailed?.();
    hooks.onFatal(error);
  }

  /** finish() 與 prepare() 的補說共用同一條路，兩邊行為必須完全一樣。 */
  function speakNow(fullText: string) {
    clearTimer();
    const duration = Math.min(fullText.length * MS_PER_CHAR, MAX_SPEAK_MS);
    hooks.onSpeakingChange(true);
    timer = setTimeout(stopSpeaking, duration);

    if (inject === "speak" && !spokeOnce) {
      spokeOnce = true;
      // 排在這一則的一半：斷線一定落在她還在講的時候，才驗得到「講到一半斷掉」那條路
      disconnectTimer = setTimeout(() => {
        disconnectTimer = null;
        reportFatal(new Error("mockFatal=speak：模擬說話中斷線"));
      }, Math.max(1, Math.floor(duration / 2)));
    }
  }

  return {
    provider: "mock",
    needsVideo: true, // 要走跟 heygen 一樣的 <video> 路徑，否則就測不到那條路
    metered: true, // 假裝在花錢，這樣閒置退場那整套才有東西可以測
    get audioAvailable() {
      return prepared;
    },

    async prepare(video) {
      if (prepared || preparing || dead || fatalReported) return;
      preparing = true;

      // 用一張靜止的畫面冒充串流：測交叉淡入時眼睛看得到差別。
      //
      // 預設**刻意不放任何真人影像**——mock 就該長得像 mock，否則在開發過程中
      // 很容易把假畫面誤認成真的串流已經接通。
      //
      // 但要看「一張真人照片套進這個版面長什麼樣」時（構圖、圓形裁切、浮水印位置），
      // 可以用 NEXT_PUBLIC_AVATAR_PREVIEW_IMAGE 指一張本機圖片。
      // ⚠️ 那個變數只該出現在本機 .env.local，**不要設進 Vercel**。
      //    現在手上已經有老師的授權素材，所以問題不再是著作權，而是誠實：
      //    設上去之後線上就會出現一張「看起來像串流、其實是靜止圖」的畫面，
      //    而 mock driver 根本不會說話。授權涵蓋的是正式的串流呈現，
      //    不是讓一張靜照冒充活著的串流。
      if (video) {
        video.poster = process.env.NEXT_PUBLIC_AVATAR_PREVIEW_IMAGE || MOCK_POSTER;
      }

      await new Promise((resolve) => setTimeout(resolve, PREPARE_DELAY_MS));
      preparing = false;
      if (dead) {
        pendingSpeech = null;
        return;
      }

      if (inject === "prepare") {
        // 像 heygen 的 token 被拒：連線期間排隊的那則由 reportFatal 報成「聲音沒出來」再丟掉
        reportFatal(new Error("mockFatal=prepare：模擬接通失敗"));
        return;
      }
      prepared = true;

      // 連線期間送進來的答案在這裡補說，跟 heygen 同一套規則。
      const queued = pendingSpeech;
      pendingSpeech = null;
      if (queued) speakNow(queued);
    },

    push() {
      // 跟 heygen 一樣：等整段答案才開口，串流中的 delta 一律忽略。
      // 這正是要讓 mock 能測出來的行為差異。
    },

    finish(fullText) {
      if (dead) return;
      if (fatalReported) {
        // 跟 heygen 一樣：已經斷了、等著被收掉，這一則沒有地方可以去——明講，不要靜靜地不出聲。
        // （只有注入故障時走得到。）
        hooks.onSpeechFailed?.();
        return;
      }
      if (!prepared) {
        // 還在連線就先排隊；根本沒開始連線的話沒有東西可以等，直接忽略。
        // ⚠️ 這一條跟 heygen 刻意不一致：heygen 在這裡會回報 onSpeechFailed（「答案無處可去」要明講），
        // mock 為了「沒帶 ?mockFatal 時行為完全不變」照舊安靜忽略。正常流程走不到（語音頁一定先 prepare）。
        if (preparing) pendingSpeech = fullText;
        return;
      }
      speakNow(fullText);
    },

    stop() {
      // 排隊中的那則也要丟掉：使用者按下去就是要打斷。
      // ⚠️ 注入的斷線不跟著取消：斷線是網路那一側的事，跟她有沒有被打斷無關
      // （被打斷之後才斷線 ＝ 閒置時斷線，只會有 onFatal，跟 heygen 一樣）。
      pendingSpeech = null;
      if (dead) return;
      stopSpeaking();
    },

    async destroy() {
      dead = true;
      pendingSpeech = null;
      clearTimer();
      if (disconnectTimer !== null) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
    },
  };
}
