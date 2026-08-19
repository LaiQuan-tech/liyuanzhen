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
 * 假 driver：不發聲、不連外、不計費，但**時序是真的**。
 *
 * 存在的理由是把「需要 HeyGen 帳號才能做的事」和「不需要的事」切開。
 * 版面、載入交叉淡入、解除靜音手勢、閒置退場、onFatal 降級、浮水印——
 * 這些全部可以用 mock 做完並測完，一毛錢都不用花，也不佔用 LiveAvatar 的分鐘數。
 *
 * 它也是唯一能在 CI 裡跑的 driver。
 */
export function createMockDriver(hooks: AvatarDriverHooks): AvatarDriver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let prepared = false;
  let preparing = false;
  let dead = false;

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

  /** finish() 與 prepare() 的補說共用同一條路，兩邊行為必須完全一樣。 */
  function speakNow(fullText: string) {
    clearTimer();
    const duration = Math.min(fullText.length * MS_PER_CHAR, MAX_SPEAK_MS);
    hooks.onSpeakingChange(true);
    timer = setTimeout(stopSpeaking, duration);
  }

  return {
    provider: "mock",
    needsVideo: true, // 要走跟 heygen 一樣的 <video> 路徑，否則就測不到那條路
    metered: true, // 假裝在花錢，這樣閒置退場那整套才有東西可以測
    get audioAvailable() {
      return prepared;
    },

    async prepare(video) {
      if (prepared || preparing || dead) return;
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
      if (!prepared) {
        // 還在連線就先排隊；根本沒開始連線的話沒有東西可以等，直接忽略。
        if (preparing) pendingSpeech = fullText;
        return;
      }
      speakNow(fullText);
    },

    stop() {
      // 排隊中的那則也要丟掉：使用者按下去就是要打斷。
      pendingSpeech = null;
      if (dead) return;
      stopSpeaking();
    },

    async destroy() {
      dead = true;
      pendingSpeech = null;
      clearTimer();
    },
  };
}
