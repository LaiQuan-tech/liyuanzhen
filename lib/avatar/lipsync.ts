/**
 * 從 PCM 直接算出嘴型時間軸——Q版數位人對嘴的核心。
 *
 * ## 為什麼不用 AnalyserNode
 *
 * 直覺作法是把音訊接進 `AudioContext` 的 `createAnalyser()`，每一幀讀一次音量。
 * 這裡刻意不那樣做，三個理由：
 *
 * 1. **測不了。** AnalyserNode 只在瀏覽器裡存在，專案的 vitest 是 node 環境
 *    （`environment: "node"`），對嘴的邏輯會變成只能靠眼睛驗收的那一類程式碼。
 *    而 `lib/live/recorder-pipeline.test.ts` 記著這個專案上一次把 AudioContext
 *    放在關鍵路徑上的下場：它整個炸掉，話就錄不到。
 * 2. **不準。** AnalyserNode 讀的是「現在喇叭在放什麼」，那已經比嘴型該動的時間
 *    晚了一個緩衝區。而 PCM 在送進喇叭之前就在我們手上，可以先算好。
 * 3. **沒必要。** 我們拿得到原始樣本，音量自己算就好，不需要再繞一次音訊圖。
 *
 * 所以這一支是純函式邏輯：吃 PCM，吐「第幾毫秒該換成哪個嘴型」。
 * 播放端只要拿 `AudioContext.currentTime` 去查表，嘴就跟聲音對齊。
 *
 * ## ⚠️ 這是「音量驅動」，不是「音素驅動」
 *
 * 嘴型是從音量推出來的（大聲＝嘴張大），不是從實際發什麼音推出來的。
 * 所以它不會分辨「衣」跟「嗚」——那兩個音一樣大聲，嘴型就一樣。
 *
 * 這是刻意的取捨，理由是它夠用：VTuber 圈的 2D 對嘴絕大多數就是這樣做的，
 * 觀眾感知到的「有沒有在講話」幾乎全部來自時間對齊，不是嘴型正確。
 * 真的要分辨母音，需要共振峰分析或一條音素時間軸——後者其實做得到，因為
 * 我們手上有文字，但那是這一版之後的事，不要為了 PoC 先做。
 */

/**
 * 嘴型。刻意只有四個。
 *
 * ⚠️ 不要為了「更精緻」而加到八個。分層立繪每多一個嘴型就是一張美術素材，
 * 而音量驅動根本分不出那麼多階——多出來的階只會在相鄰兩張之間抖。
 */
export type Viseme = "closed" | "small" | "mid" | "wide";

/** 依張開程度排序，播放端可以用索引做補間 */
export const VISEME_ORDER: readonly Viseme[] = ["closed", "small", "mid", "wide"];

export interface VisemeFrame {
  /** 相對於「整段話開頭」的毫秒數。跨 chunk 累計，不是這一段的相對時間 */
  atMs: number;
  viseme: Viseme;
  /** 正規化後的張嘴程度 0–1，播放端要做補間的話用這個 */
  level: number;
}

export interface LipSyncOptions {
  /** 取樣率。ElevenLabs 的 `output_format=pcm_24000` 就是 24000 */
  sampleRate?: number;
  /**
   * 每一幀多長。40ms ＝ 每秒 25 次嘴型更新。
   *
   * ⚠️ 不要調到 16ms 想「更順」。音量在單一音節內本來就會抖，
   * 幀太短會讓嘴在同一個字裡面開開合合，看起來像在發抖而不是在講話。
   * 順不順要靠播放端補間，不是靠提高取樣密度。
   */
  frameMs?: number;
}

const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_FRAME_MS = 40;

/** Int16 的滿刻度。RMS 除以它就得到 0–1 */
const INT16_FULL_SCALE = 32768;

/**
 * 包絡跟隨的兩個係數。開口要快、閉口要慢。
 *
 * 🔴 兩個值不對稱是重點，不是隨手填的。相同的話，子音之間那些短暫的低音量
 * 會讓嘴一路閉起來又打開——講一句話嘴巴閉合十幾次，那是金魚不是人。
 * 快攻擊讓嘴在音節一開始就跟上，慢釋放讓它在音節之間保持微張。
 */
const ATTACK = 0.65;
const RELEASE = 0.12;

/**
 * 🔴 真的沒有訊號時，用另一條快得多的釋放曲線。
 *
 * 這一條是被測試逼出來的，不是設計時想到的。原本只有一條 RELEASE=0.12，
 * 結果「句子講完之後嘴要閉起來」那條測試失敗：講完話 600ms，嘴還停在 small。
 *
 * 原因是自適應增益把靜音也一起正規化了——分母 `gainRef` 跟著分子 `envelope`
 * 一起往下掉（只是慢一點），比值降不下去，嘴就一直微張。
 *
 * 所以要分開兩種「安靜」：
 *   音節之間 —— 有訊號只是變小 → 慢慢放，嘴保持微張（不然像金魚）
 *   句子結束 —— 真的沒有訊號   → 快速放，嘴確實閉上
 */
const RELEASE_SILENT = 0.5;

/**
 * 絕對靜音門檻（約 -46 dBFS）。低於這個值就是「真的沒有訊號」。
 *
 * 🔴 這是自適應增益的煞車。增益的用途是讓小聲講話也有嘴型，
 * 但它絕對不可以把「靜音」放大成「小聲」——那會讓嘴在她沒講話的時候動。
 * 所以最後還有一道絕對閘：包絡低於這個值一律回 0，不管增益算出什麼。
 *
 * ⚠️ 數值要遠低於「小聲講話」。實測 amplitude 0.06 的正弦波 RMS 約 0.042，
 * 是這個門檻的 8 倍，安全。
 */
const ABSOLUTE_FLOOR = 0.005;

/**
 * 自適應增益的追蹤速度。
 *
 * 為什麼需要它：同一段話裡她講重點會大聲、補充說明會小聲，
 * 用固定門檻的話小聲那段嘴幾乎不動，看起來像沒在講話。
 * 這條線追蹤「最近的響度」，讓門檻跟著走。
 *
 * ⚠️ 只往下追得慢、往上追得快——不然一句話結尾的靜音會把增益拉爆，
 * 下一句話的第一個字就會炸成全開。
 */
const GAIN_RISE = 0.30;
const GAIN_FALL = 0.02;

/** 低於這個正規化音量就當作沒在講話。⚠️ 不能設 0，底噪會讓嘴一直微張 */
const SILENCE_FLOOR = 0.08;

/** 正規化音量 → 嘴型的門檻。三個數字把 0–1 切成四段 */
const THRESHOLDS: readonly { min: number; viseme: Viseme }[] = [
  { min: 0.55, viseme: "wide" },
  { min: 0.28, viseme: "mid" },
  { min: SILENCE_FLOOR, viseme: "small" },
];

/**
 * 一段 PCM 的 RMS，回傳 0–1。
 *
 * ⚠️ 一定要用 `byteOffset`。傳進來的 Uint8Array 常常是 `subarray()` 切出來的
 * 視窗，它的 `buffer` 是整塊原始緩衝——不帶 offset 的話會從別人的資料開始算。
 */
export function rmsOf(pcm: Uint8Array): number {
  const sampleCount = Math.floor(pcm.byteLength / 2);
  if (sampleCount === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, sampleCount * 2);
  let sum = 0;
  for (let i = 0; i < sampleCount; i++) {
    const s = view.getInt16(i * 2, true) / INT16_FULL_SCALE;
    sum += s * s;
  }
  return Math.sqrt(sum / sampleCount);
}

/** 正規化音量 → 嘴型。門檻表由大到小掃，第一個符合的就是答案 */
export function visemeForLevel(level: number): Viseme {
  for (const t of THRESHOLDS) {
    if (level >= t.min) return t.viseme;
  }
  return "closed";
}

/**
 * 有狀態的對嘴分析器。一段話一個實例。
 *
 * 🔴 狀態必須跨 chunk 保留，這是整支的關鍵。TTS 是一秒一段串流進來的，
 * 如果每一段各自算各自的增益，每一秒的開頭都會重新校準一次響度，
 * 嘴型會以一秒為週期規律地脈動——那個瑕疵非常明顯，而且很難事後debug，
 * 因為單獨看任何一段都是對的。
 */
export class LipSyncAnalyser {
  private readonly sampleRate: number;
  private readonly frameSamples: number;
  private readonly frameBytes: number;

  /** 不滿一幀的尾巴，留到下一次 push 再湊 */
  private remainder: Uint8Array = new Uint8Array(0);
  /** 已經吐出去幾幀——用來算 atMs，不受 remainder 影響 */
  private framesEmitted = 0;
  private envelope = 0;
  private gainRef = 0;

  constructor(options: LipSyncOptions = {}) {
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
    this.frameSamples = Math.max(1, Math.round((this.sampleRate * frameMs) / 1000));
    this.frameBytes = this.frameSamples * 2;
  }

  /** 每一幀代表多少毫秒。播放端排程要用 */
  get frameDurationMs(): number {
    return (this.frameSamples / this.sampleRate) * 1000;
  }

  /**
   * 餵一段 PCM，拿回這段對應的嘴型幀。
   *
   * ⚠️ 回傳的 `atMs` 是相對於「整段話開頭」的絕對時間，不是這一段的相對時間。
   * 播放端可以直接拿它跟播放時鐘比對，不需要自己累加偏移量。
   */
  push(pcm: Uint8Array): VisemeFrame[] {
    const buf = this.concatRemainder(pcm);
    const frames: VisemeFrame[] = [];
    let offset = 0;

    while (buf.byteLength - offset >= this.frameBytes) {
      const level = this.advance(buf.subarray(offset, offset + this.frameBytes));
      frames.push({
        atMs: Math.round(this.framesEmitted * this.frameDurationMs),
        viseme: visemeForLevel(level),
        level,
      });
      this.framesEmitted++;
      offset += this.frameBytes;
    }

    // ⚠️ 尾巴要 copy 而不是 subarray：buf 下一輪會被丟掉，留著 view 會指向死記憶體
    this.remainder = buf.slice(offset);
    return frames;
  }

  /**
   * 串流結束時呼叫，把不滿一幀的尾巴補成最後一幀。
   *
   * 為什麼需要：最後那不到 40ms 常常正好是句尾的收音，少了它嘴會停在張開的
   * 狀態上——一句話講完嘴不閉起來，比對不準還明顯。
   */
  flush(): VisemeFrame[] {
    if (this.remainder.byteLength < 2) {
      this.remainder = new Uint8Array(0);
      return [];
    }
    const level = this.advance(this.remainder);
    const frame: VisemeFrame = {
      atMs: Math.round(this.framesEmitted * this.frameDurationMs),
      viseme: visemeForLevel(level),
      level,
    };
    this.framesEmitted++;
    this.remainder = new Uint8Array(0);
    return [frame];
  }

  reset(): void {
    this.remainder = new Uint8Array(0);
    this.framesEmitted = 0;
    this.envelope = 0;
    this.gainRef = 0;
  }

  /** 一幀：RMS → 包絡跟隨 → 自適應增益 → 0–1 */
  private advance(frame: Uint8Array): number {
    const rms = rmsOf(frame);

    // 開口一律快；閉口分兩種——有訊號慢放（音節之間），沒訊號快放（句子結束）
    const release = rms < ABSOLUTE_FLOOR ? RELEASE_SILENT : RELEASE;
    const coeff = rms > this.envelope ? ATTACK : release;
    this.envelope = this.envelope + (rms - this.envelope) * coeff;

    const gainCoeff = this.envelope > this.gainRef ? GAIN_RISE : GAIN_FALL;
    this.gainRef = this.gainRef + (this.envelope - this.gainRef) * gainCoeff;

    // 🔴 絕對閘，擋在增益前面：真的沒有訊號就是閉著，不管增益算出什麼。
    // 少了這一行，自適應增益會把靜音放大成「小聲」，嘴在她沒講話時還在動。
    if (this.envelope < ABSOLUTE_FLOOR) return 0;

    // ⚠️ 除以 0 的守門。整段靜音時 gainRef 會是 0，這時候答案就是「閉著」
    if (this.gainRef < 1e-4) return 0;

    // 除以 1.4 倍的參考值：讓「平均音量」落在 mid 而不是 wide，
    // 留出上面那段給真正大聲的字，否則整句話都是全開。
    const level = this.envelope / (this.gainRef * 1.4);
    return Math.min(1, Math.max(0, level));
  }

  private concatRemainder(pcm: Uint8Array): Uint8Array {
    if (this.remainder.byteLength === 0) return pcm;
    const merged = new Uint8Array(this.remainder.byteLength + pcm.byteLength);
    merged.set(this.remainder, 0);
    merged.set(pcm, this.remainder.byteLength);
    return merged;
  }
}
