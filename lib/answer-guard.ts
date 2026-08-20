/**
 * 縱深防禦的最後一層：邊串流邊掃描輸出。
 *
 * 誠實說明：這是 defense-in-depth，不是保證。真正的保證來自檢索門檻
 * （離題問題根本到不了模型）。這一層擋的是「模型雖然拿到相關資料，
 * 卻仍然說出不該說的話」的殘餘風險。
 */

/** 命中就整段換掉，不是遮字——半句被遮的答案比婉拒更難看 */
const BLOCKED_PATTERNS: RegExp[] = [
  // 政黨與政治立場表態
  //
  // ⚠️ 這裡原本是「出現黨名就整段擋掉」。灌進自傳之後那樣不行了：
  // 第 1 章就寫著「我們一家四口跟隨國民黨政府撤離大陸」，第 5 章談婦運與
  // 立法院合作時也一定會提到政黨。訪客問「你們一家是怎麼來臺灣的？」
  // 會拿到一句莫名其妙的婉拒——那不是安全，那是壞掉。
  //
  // 所以改成擋「表態」而不是擋「提及」：黨名要跟評價或選擇的動詞同時出現才算。
  // 歷史敘述（撤退、遷臺、當年執政、某某是某黨立委）一律放行。
  /(支持|反對|投票給|票投|比較認同|站在)[^。！？]{0,10}(民進黨|國民黨|民眾黨|時代力量|台灣民眾黨|共產黨)/,
  /(民進黨|國民黨|民眾黨|時代力量|台灣民眾黨|共產黨)[^。！？]{0,10}(很好|不錯|最好|比較好|做得好|做得比較好|才是對的|比較差|做得不好|不好|很糟|很爛|最爛|差勁)/,
  /(覺得|認為|我想)[^。！？]{0,8}(民進黨|國民黨|民眾黨|時代力量|台灣民眾黨|共產黨)/,
  /我(支持|反對|投票給|比較認同)[^。！？]{0,12}(黨|候選人|總統)/,
  // 以本人身分做出新承諾
  /(我保證|我承諾|我呼籲大家|我在此宣布)/,
  // 未經確認的新書具體資訊
  /(ISBN|定價|售價)\s*[:：]?\s*\d/,
  /新書.{0,6}(將於|預計|訂於).{0,10}(出版|上市|發行)/,
];

export interface GuardResult {
  text: string;
  blocked: boolean;
  matched?: string;
}

export function checkAnswer(text: string): GuardResult {
  for (const pattern of BLOCKED_PATTERNS) {
    const m = text.match(pattern);
    if (m) return { text, blocked: true, matched: m[0] };
  }
  return { text, blocked: false };
}

/** 語音朗讀會把符號唸出來，所以殘留的 Markdown 一律清掉 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|\s)[*_](\S[^*_]*)[*_]/g, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1");
}

const BUFFER_CHARS = 60;

/**
 * 滾動緩衝的串流寫入器：先扣住尾端 60 字再吐出，
 * 讓封鎖樣式在跨 delta 邊界時也能被抓到。延遲約 0.3 秒，肉眼看不出來。
 */
export function createGuardedWriter(
  emit: (text: string) => void,
  onBlocked: (matched: string) => void
) {
  let pending = "";
  let full = "";
  let blocked = false;

  return {
    push(delta: string) {
      if (blocked) return;
      pending += delta;
      full += delta;

      const check = checkAnswer(full);
      if (check.blocked) {
        blocked = true;
        onBlocked(check.matched ?? "unknown");
        return;
      }

      if (pending.length > BUFFER_CHARS) {
        const flushable = pending.slice(0, pending.length - BUFFER_CHARS);
        pending = pending.slice(pending.length - BUFFER_CHARS);
        emit(stripMarkdown(flushable));
      }
    },
    finish(): { text: string; blocked: boolean } {
      if (blocked) return { text: full, blocked: true };
      if (pending) {
        emit(stripMarkdown(pending));
        pending = "";
      }
      return { text: full, blocked: false };
    },
  };
}
