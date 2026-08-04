/**
 * 瀏覽器語音朗讀。看似簡單，但每一條註解都是一個會在提案現場咬人的坑。
 */

export type SpeakState = "idle" | "speaking";

const SENTENCE_BREAK = /([。！？；!?;\n])/;

/** 中文語音的偏好順序。都找不到就整個停用，絕不能讓英文語音去唸中文。 */
const PREFERRED_LANGS = ["zh-TW", "zh-HK", "zh-CN", "zh"];

export function isTtsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * Chrome 的 getVoices() 第一次呼叫常常回空陣列，要等 voiceschanged 事件。
 * 沒處理這件事，第一次按朗讀就會沒聲音——而那通常就是示範的第一次。
 */
export function loadVoices(timeoutMs = 2000): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (!isTtsSupported()) return resolve([]);

    const existing = window.speechSynthesis.getVoices();
    if (existing.length) return resolve(existing);

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      window.speechSynthesis.removeEventListener("voiceschanged", done);
      resolve(window.speechSynthesis.getVoices());
    };

    window.speechSynthesis.addEventListener("voiceschanged", done);
    setTimeout(done, timeoutMs);
  });
}

export function pickChineseVoice(
  voices: SpeechSynthesisVoice[]
): SpeechSynthesisVoice | null {
  for (const lang of PREFERRED_LANGS) {
    const match = voices.find((v) => v.lang.replace("_", "-").startsWith(lang));
    if (match) return match;
  }
  return null;
}

export class Speaker {
  private voice: SpeechSynthesisVoice | null = null;
  private buffer = "";
  private queue: string[] = [];
  private speaking = false;
  private stopped = false;
  private onState?: (state: SpeakState) => void;

  /** 回傳 false 代表這台裝置沒有中文語音，呼叫端應該把朗讀按鈕停用 */
  async init(onState?: (state: SpeakState) => void): Promise<boolean> {
    this.onState = onState;
    if (!isTtsSupported()) return false;
    const voices = await loadVoices();
    this.voice = pickChineseVoice(voices);
    return this.voice !== null;
  }

  get available(): boolean {
    return this.voice !== null;
  }

  /**
   * 餵入串流文字，內部自行斷句後排隊朗讀。
   * 逐句朗讀（而不是等全文結束才唸）才是頭像「活著」的關鍵。
   */
  push(delta: string) {
    if (!this.available || this.stopped) return;
    this.buffer += delta;

    const parts = this.buffer.split(SENTENCE_BREAK);
    // split 後標點會單獨成項，兩兩接回去
    let carry = "";
    const sentences: string[] = [];
    for (const part of parts) {
      if (SENTENCE_BREAK.test(part) && part.length === 1) {
        sentences.push((carry + part).trim());
        carry = "";
      } else {
        carry += part;
      }
    }
    this.buffer = carry;

    for (const sentence of sentences) {
      if (sentence) this.queue.push(sentence);
    }
    this.drain();
  }

  /** 串流結束時把殘留的最後一句唸掉 */
  flush() {
    if (!this.available || this.stopped) return;
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest) {
      this.queue.push(rest);
      this.drain();
    }
  }

  stop() {
    this.stopped = true;
    this.buffer = "";
    this.queue = [];
    this.speaking = false;
    if (isTtsSupported()) window.speechSynthesis.cancel();
    this.onState?.("idle");
  }

  /** 每次新回答開始前呼叫，解除上一次 stop 的鎖定 */
  reset() {
    this.stopped = false;
    this.buffer = "";
    this.queue = [];
  }

  private drain() {
    if (this.speaking || this.stopped) return;
    const next = this.queue.shift();
    if (!next) {
      this.onState?.("idle");
      return;
    }

    const utterance = new SpeechSynthesisUtterance(next);
    if (this.voice) utterance.voice = this.voice;
    utterance.lang = this.voice?.lang ?? "zh-TW";
    utterance.rate = 1;
    utterance.pitch = 1;

    utterance.onend = () => {
      this.speaking = false;
      this.drain();
    };
    utterance.onerror = () => {
      this.speaking = false;
      this.drain();
    };

    this.speaking = true;
    this.onState?.("speaking");
    window.speechSynthesis.speak(utterance);
  }
}
