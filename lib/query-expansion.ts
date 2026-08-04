/**
 * 把「那後來呢？」這種依賴上文的追問，改寫成可以獨立 embedding 的查詢。
 * 純字串處理，不多花一次 LLM 呼叫、不增加延遲。
 */

/** 代詞／承接詞：出現這些就代表這句話得靠上文才看得懂 */
const ANAPHORA = /(那|這|他|她|它|其|後來|然後|接著|再來|之後|還有|呢\s*[?？]?$)/;

const MIN_STANDALONE_LENGTH = 12;

export interface HistoryTurn {
  role: "user" | "model";
  text: string;
}

export function expandQuery(message: string, history: HistoryTurn[] = []): string {
  const current = message.trim();
  if (!current) return current;

  const needsContext =
    current.length < MIN_STANDALONE_LENGTH || ANAPHORA.test(current);
  if (!needsContext) return current;

  // 往回找最近一則使用者訊息當作主題錨
  const previousUser = [...history]
    .reverse()
    .find((turn) => turn.role === "user" && turn.text.trim().length >= MIN_STANDALONE_LENGTH);

  if (!previousUser) return current;
  return `${previousUser.text.trim()} ${current}`;
}
