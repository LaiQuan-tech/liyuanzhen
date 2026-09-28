import type { NextRequest } from "next/server";
import { retrieve } from "@/lib/retrieval";
import { streamChatResponse } from "@/lib/gemini-chat";
import { createGuardedWriter } from "@/lib/answer-guard";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { logInteraction } from "@/lib/interaction-log";
import type { InteractionChannel, InteractionRecord } from "@/lib/interaction-log";
import {
  OUT_OF_SCOPE_REPLY,
  GUARDED_REPLY,
  UNGROUNDED_REPLY,
  PRIVACY_REPLY,
  FALLBACK_REPLY,
  CRISIS_SELF_HARM_REPLY,
  CRISIS_VIOLENCE_REPLY,
  SMALLTALK_GREETING_REPLY,
  SMALLTALK_THANKS_REPLY,
  SMALLTALK_FAREWELL_REPLY,
  SMALLTALK_PRAISE_REPLY,
  REFUSAL_PRIVACY_REPLY,
  REFUSAL_PROFANITY_REPLY,
  REFUSAL_HARASSMENT_REPLY,
  REFUSAL_MEDICAL_REPLY,
  REFUSAL_FINANCE_REPLY,
  REFUSAL_ERRAND_REPLY,
  REFUSAL_CREATION_REPLY,
} from "@/content/site";
import type { HistoryTurn } from "@/lib/query-expansion";
import { detectCrisis, hotlineKind, type CrisisKind } from "@/lib/crisis";
import { detectSmalltalk, modelInvites, type SmalltalkKind } from "@/lib/smalltalk";
import { detectRefusalRequest, type RefusalKind } from "@/lib/refusal-request";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * 預熱。
 *
 * 🔴 這支存在的理由是原本的預熱**打錯了對象**。
 * `/live` 掛載時 ping 的是 `/api/health`，而那支在正式站是被 Vercel 邊緣快取的
 *（實測 `x-vercel-cache: HIT`、`age: 141`），請求根本到不了任何 lambda。
 * 真正需要熱的是這一支，而它從來沒被熱過。
 *
 * 症狀：安靜一段時間之後的第一個問題會撞上冷啟動。實測正式站上一次
 * 超過 20 秒而被前端的逾時丟掉，訪客看到的是「抱歉，我需要休息一下」——
 * 一個完全正確的請求，被當成失敗。
 *
 * ⚠️ 這支刻意什麼都不做。lambda 被叫醒、模組被求值，預熱就完成了；
 * 多做任何事都只是給不需要的人花錢。
 */
export async function GET() {
  return new Response(JSON.stringify({ warm: true }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}


const MAX_MESSAGE_CHARS = 300;
const MAX_MESSAGES = 13; // 6 輪來回 + 這次的提問

function textResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** 擋掉隨手把端點嵌到別的站上的行為。腳本可偽造，所以只是第一道。 */
function originAllowed(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // 同源導覽與伺服器端呼叫不帶 origin
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

const CRISIS_REPLY: Record<CrisisKind, string> = {
  self_harm: CRISIS_SELF_HARM_REPLY,
  violence: CRISIS_VIOLENCE_REPLY,
};

/** 感謝與應答共用同一句（content/site.ts 的 SMALLTALK_THANKS_REPLY 上方註解） */
const SMALLTALK_REPLY: Record<SmalltalkKind, string> = {
  greeting: SMALLTALK_GREETING_REPLY,
  thanks: SMALLTALK_THANKS_REPLY,
  ack: SMALLTALK_THANKS_REPLY,
  farewell: SMALLTALK_FAREWELL_REPLY,
  praise: SMALLTALK_PRAISE_REPLY,
};

const REFUSAL_REPLY: Record<RefusalKind, string> = {
  privacy: REFUSAL_PRIVACY_REPLY,
  profanity: REFUSAL_PROFANITY_REPLY,
  harassment: REFUSAL_HARASSMENT_REPLY,
  medical: REFUSAL_MEDICAL_REPLY,
  finance: REFUSAL_FINANCE_REPLY,
  errand: REFUSAL_ERRAND_REPLY,
  creation: REFUSAL_CREATION_REPLY,
};

/**
 * 串一段固定文字回去：危機、寒暄、限流中的危機都走這裡。
 * record 有給就照離題分支的寫法——⚠️ 先 await 記錄再 close（serverless 在回應結束後會凍結實例）；
 * 給 null 就不寫 interactions。
 */
function fixedReply(reply: string, scope: string, record: InteractionRecord | null): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(reply));
      if (record) {
        try {
          await logInteraction(record);
        } catch (err) {
          console.error("[chat] 記錄失敗：", err);
        }
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Retrieval-Scope": scope },
  });
}

/** 上一個 model 回合的文字；沒有就是空字串。 */
function lastModelText(history: HistoryTurn[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "model") return history[i].text;
  }
  return "";
}

/**
 * 上一個 model 回合是不是危機回覆；是的話回那一句（「延續」用，見 POST 裡的說明）。
 *
 * 前端把串流收到的整段文字原樣存成 model 回合（ChatPanel 的 answer、LiveStage 的 full），
 * 所以比對結尾就夠。用「結尾是那一句」而不是全等：延續本身可能接在模型吐出的空白後面。
 */
function crisisReplyInHistory(history: HistoryTurn[]): string | null {
  const text = lastModelText(history).trim();
  return [CRISIS_SELF_HARM_REPLY, CRISIS_VIOLENCE_REPLY].find((reply) => text.endsWith(reply)) ?? null;
}

/** 請求裡的對話回合（跟 POST 主流程同一套篩法）。 */
function turnsOf(messages: unknown[]): HistoryTurn[] {
  return messages
    .slice(-MAX_MESSAGES)
    .filter(
      (m): m is HistoryTurn =>
        !!m &&
        typeof (m as HistoryTurn).text === "string" &&
        ((m as HistoryTurn).role === "user" || (m as HistoryTurn).role === "model")
    );
}

/**
 * 被限流擋下的請求要不要照樣回危機回覆：最後一句是求助危機，或是接在危機回覆後面（延續）。
 * 🔴 延續是第三輪驗收補的：剛拿到危機回覆的人被限流時說「打了沒人接」，原本會收到「今天的展示額度已用完」。
 * 解析失敗、格式不對一律當作不是——這條路只放行那兩句專線文字，其餘照舊回 429。
 */
async function crisisReplyForRejected(request: NextRequest): Promise<string | null> {
  try {
    const { messages } = ((await request.json()) ?? {}) as { messages?: unknown };
    if (!Array.isArray(messages)) return null;
    const turns = turnsOf(messages);
    const last = turns[turns.length - 1];
    if (!last || last.role !== "user" || !last.text.trim()) return null;
    const kind = detectCrisis(last.text.trim().slice(0, MAX_MESSAGE_CHARS));
    return kind ? CRISIS_REPLY[kind] : crisisReplyInHistory(turns.slice(0, -1));
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  if (!originAllowed(request)) {
    return textResponse("請從本網站發起提問。", 403);
  }

  const verdict = rateLimit(clientIp(request.headers));
  if (!verdict.ok) {
    // 🔴 求助危機不能被限流擋掉。危機判斷原本排在限流之後，被 429 擋下的求助者會拿到
    // 「今天的展示額度已用完」。所以先看最後一句：是危機、或接在危機回覆後面（延續），就照樣回危機回覆。
    // 這條路只回固定文字（不檢索、不呼叫 LLM、不花錢），所以不寫 interactions、不再計一次額度；
    // 其餘照舊回 429——它放行的只有那兩句專線文字，拿不到任何模型的回答。
    const crisisReply = await crisisReplyForRejected(request);
    if (crisisReply) return fixedReply(crisisReply, "crisis", null);

    const message =
      verdict.reason === "global"
        ? "今天的展示額度已用完，請明天再來，或直接與我們聯絡。"
        : "您問得有點快，請稍等一下再試。";
    return new Response(message, {
      status: 429,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Retry-After": String(verdict.retryAfter),
      },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return textResponse("請求格式錯誤。", 400);
  }

  const { sessionId, messages, channel: rawChannel } = (body ?? {}) as {
    sessionId?: unknown;
    messages?: unknown;
    channel?: unknown;
  };

  if (typeof sessionId !== "string" || !Array.isArray(messages) || messages.length === 0) {
    return textResponse("請求格式錯誤。", 400);
  }

  // 打字來的還是講話來的。⚠️ 不認得的值一律當 null，不要原封不動存進資料庫——
  // 這個欄位有 check constraint，塞別的字串會讓整筆記錄寫入失敗，
  // 而寫入失敗是被 try/catch 吞掉的，訪客沒事、資料默默不見。
  const channel: InteractionChannel | null =
    rawChannel === "chat" || rawChannel === "live" ? rawChannel : null;

  const turns = turnsOf(messages);

  const last = turns[turns.length - 1];
  if (!last || last.role !== "user" || !last.text.trim()) {
    return textResponse("請求格式錯誤。", 400);
  }

  const question = last.text.trim().slice(0, MAX_MESSAGE_CHARS);
  const history = turns.slice(0, -1);

  // 🔴 求助危機 → 在檢索「之前」攔下來，直接回固定的、號碼正確的文字。
  // 完全不呼叫檢索與 LLM，也不經過護欄。正式站實測，這類訊息走「只根據語料回答＋落地檢查」
  // 會得到最糟的結果：「我真的不想活了」模型本來答對了（「快撥打 1925 安心專線」），
  // 落地檢查卻因為專線號碼不在語料裡把它換成「這一題我答不上來」；家暴求助被答成婦運史加導購，
  // 沒有任何求助資源。判準見 lib/crisis.ts，文字與號碼見 content/site.ts。
  //
  // ⚠️ 只看這一句、不看歷史（lib/crisis.ts 檔頭判準 1）。
  // ⚠️ 記錄照離題分支的寫法：先 await 記錄再 close。inScope: true（不是離題婉拒）、
  // topSimilarity: 0（根本沒有檢索）。回應標頭 X-Retrieval-Scope: crisis，給腳本分辨用。
  const crisis = detectCrisis(question);
  if (crisis) {
    const reply = CRISIS_REPLY[crisis];
    return fixedReply(reply, "crisis", {
      sessionId,
      questionText: question,
      answerSummary: reply,
      topSimilarity: 0,
      inScope: true,
      blocked: false,
      failed: false,
      channel,
    });
  }

  // 🔴 延續：上一個 model 回合是危機回覆時，這一句多半是接著危機在說話——
  // 「打了沒人接」「可是我不敢打電話」「我現在在頂樓了」「我好痛苦」。這些句子單獨看不是危機
  // （detectCrisis 不會中），交給 RAG 會拿到離題罐頭或「這一題我答不上來」。
  // 所以這一句如果被判離題、被輸出護欄攔下（任何一種，第十五輪起含封鎖清單與推理外洩）、模型回空白或生成失敗，
  // 就再送一次**同一句**危機回覆；
  // 在範圍內、模型也正常回答的提問照常回答（例如接著問婦女新知）。
  // 寒暄路徑在延續時也不接手：危機對話裡的「好」「嗯」不能被回一句「不客氣」。
  const continuing = crisisReplyInHistory(history);

  // 私人資訊與髒話請求（判準見 lib/refusal-request.ts）：要她或她家人的電話、LINE、地址，問她家人的名字
  // 與行蹤，或叫她罵髒話——直接回固定的拒絕，不檢索、不呼叫 LLM。最終建置重跑剩下的 3 題失敗就是這一類：
  // 模型其實都正確拒絕了，但措辭每次不同，落地檢查常把拒絕換成「這一題我答不上來」，答非所問。
  // 對她的身體、衣著、性、親密關係的騷擾式提問也走這裡（「妳穿什麼顏色的內衣」原本被判離題、回了離題罐頭，
  // 等於沒拒絕，還像在邀請繼續問）。
  // 記錄照寒暄的寫法；回應標頭 X-Retrieval-Scope: refusal。
  // ⚠️ 順序：危機判斷與危機延續在前——「我被打了 可以給我妳的電話嗎」要回危機回覆，上一句是危機回覆時也不接手。
  // 排在寒暄之前，但兩者互斥、先後不影響結果：寒暄要「整句」就是招呼語，這裡要的是帶著內容的請求。
  // 放前面是讓「應答接在邀請後面」那條例外只管寒暄自己，不必顧慮拒絕這一類。
  if (!continuing) {
    const refusal = detectRefusalRequest(question);
    if (refusal) {
      const reply = REFUSAL_REPLY[refusal];
      return fixedReply(reply, "refusal", {
        sessionId,
        questionText: question,
        answerSummary: reply,
        topSimilarity: 0,
        inScope: true,
        blocked: false,
        failed: false,
        channel,
      });
    }
  }

  // 寒暄快速路徑：整句只是招呼、感謝、道別或應答（判準見 lib/smalltalk.ts）時直接回固定文字，
  // 不檢索、不呼叫 LLM。本機完整重跑時「你食飽未」「哈哈」這類寒暄常被落地檢查換成
  // 「這一題我答不上來」，對公開的數位人是最常見也最難看的失誤。排在危機判斷之後、檢索之前。
  // 記錄照危機分支的寫法；回應標頭 X-Retrieval-Scope: smalltalk。
  // ⚠️ 上一句以問句或邀請收尾時（「想聽聽我創辦婦女新知的經過嗎？」），應答類（好啊、嗯嗯）是要她繼續，
  // 不走寒暄——交給原路徑，query-expansion 會把它當追問接上前一題。招呼、感謝、道別不受影響。
  if (!continuing) {
    const smalltalk = detectSmalltalk(question);
    const answersInvitation = smalltalk === "ack" && modelInvites(lastModelText(history));
    if (smalltalk && !answersInvitation) {
      const reply = SMALLTALK_REPLY[smalltalk];
      return fixedReply(reply, "smalltalk", {
        sessionId,
        questionText: question,
        answerSummary: reply,
        topSimilarity: 0,
        inScope: true,
        blocked: false,
        failed: false,
        channel,
      });
    }
  }

  // 檢索失敗要軟性降級，不能讓整個對話掛掉
  //
  // ⚠️ 但降級的結果跟「訪客真的問了不相干的事」長得一模一樣（都是 inScope: false）。
  // 後台要分得出來，否則系統故障會被當成正常的離題婉拒而沒有人去看。
  let result;
  let retrievalFailed = false;
  try {
    result = await retrieve(question, history);
  } catch (err) {
    console.error("[chat] 檢索失敗：", err);
    retrievalFailed = true;
    result = {
      chunks: [],
      topSimilarity: 0,
      inScope: false,
      lowConfidence: true,
      provider: "local" as const,
    };
  }

  const encoder = new TextEncoder();

  // 離題 → 直接婉拒，完全不呼叫 LLM。這既省錢，也是最強的 prompt injection 防線。
  // 延續中（上一句是危機回覆）改送同一句危機回覆，不是離題罐頭——見上面「延續」的說明。
  if (!result.inScope) {
    const outReply = continuing ?? OUT_OF_SCOPE_REPLY;
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(outReply));
        try {
          await logInteraction({
            sessionId,
            questionText: question,
            answerSummary: outReply,
            topSimilarity: result.topSimilarity,
            inScope: false,
            blocked: false,
            failed: retrievalFailed,
            channel,
          });
        } catch (err) {
          console.error("[chat] 記錄失敗：", err);
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Retrieval-Scope": continuing ? "crisis" : "out",
      },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      let answer = "";
      let blocked = false;
      let failed = false;
      /** 護欄給的攔截原因。專線救援只接「落地率 N%」這一種（見下面） */
      let blockReason = "";

      // 🔴 第三個參數是落地檢查要用的出處。給了它，護欄才會在 finish() 時
      // 驗「答案的字在檢索到的東西裡找不找得到」——擋的是模型用預訓練知識
      // 編出一整段語料裡沒有的話（實際發生過，見 lib/answer-guard.ts 的說明）。
      // 攔截原因（「落地率 3%」「未落地引用：〈狼來了〉」）會從 matched 帶進下面的 warn。
      const writer = createGuardedWriter(
        (text) => controller.enqueue(encoder.encode(text)),
        (matched) => {
          blocked = true;
          blockReason = matched;
          console.warn("[chat] 輸出護欄攔截：", matched);
        },
        { question, chunks: result.chunks }
      );

      try {
        await streamChatResponse(
          question,
          result.chunks,
          history,
          (delta) => writer.push(delta),
          { lowConfidence: result.lowConfidence }
        );
        const finished = writer.finish();
        answer = finished.text;
        // 🔴 專線救援：落地檢查攔下的原答是在勸這位訪客打求助專線時，改送對應類別的危機回覆
        // （號碼以固定文字為準）。第三輪驗收實測「我好痛苦」模型回了「可以打 1925 安心專線」，
        // 卻被換成「這一題我答不上來」。
        // ⚠️ 三個條件同時成立才救（第四輪驗收：原本條件太寬，誤送了 6 句正常提問，
        // 包括「我老公外遇 我該離婚嗎」——模型提了 1925，那不是求助）：
        //   (a) 攔下原因是落地率不足（護欄的原因字串以「落地率」開頭），不是未落地引用——
        //       未落地引用是模型編了書名或篇名，跟有沒有人在求助無關；
        //   (b) 訪客這一句本身有第一人稱的痛苦或受害字眼；(c) 號碼在專線語境——
        //   (b)(c) 見 lib/crisis.ts 的 hotlineKind。
        // 紀錄：answerSummary 是送出去的危機回覆，blocked 維持 true（後台要看得出原答被攔過）。
        // 延續中照舊走延續（同一類），不看原答。空白答案沒有字可看，救不到也不需要救。
        const rescued =
          (finished.blocked || blocked) &&
          finished.kind === "grounding" &&
          blockReason.startsWith("落地率") &&
          !continuing
            ? hotlineKind(finished.text, question)
            : null;
        if (rescued) {
          console.warn("[chat] 落地檢查攔下的原答在勸人打專線，改送危機回覆：", rescued);
          answer = CRISIS_REPLY[rescued];
          blocked = true;
          controller.enqueue(encoder.encode(answer));
        } else if (finished.blocked || blocked) {
          blocked = true;
          // kind 分辨四種攔截原因：pattern＝封鎖清單命中（政治表態／新承諾／新書資訊），
          // leak＝推理外洩（第十五輪從封鎖清單分出來），privacy＝在世家人隱私與老師近況（第十輪分出來），
          // grounding＝落地率不足或未落地引用。分不出來（理論上不會發生，只是防呆）時退回 GUARDED_REPLY。
          // 見 content/site.ts 那幾句上方的註解。
          // 🔴 延續中（上一句是危機回覆）不管哪一種攔截，一律送同一句危機回覆。
          // 第十五輪（獨立審查）：原本只有落地檢查與隱私接延續，pattern 照舊送 GUARDED_REPLY——訪客剛說完不想活、
          // 接著說「可是我不知道要跟誰說」，模型的安慰句含「我保證你不是一個人」被封鎖清單攔下，
          // 訪客收到「這部分我不方便表態…要不要換個方向試試？」，延續就斷了。對正在求助的人，專線比任何罐頭句都重要。
          // （第十四輪：「我媽失智了 我一個人照顧她」回老師家人的隱私說明也是同一種答非所問。）
          // 🔴 leak＝模型的推理漏進輸出（英文推理、數字數、草稿標記），是模型故障不是表態：
          // 送 FALLBACK_REPLY（跟生成失敗同一句），而且記 failed，後台才看得到——原本跟政治共用「這部分我不方便表態」，
          // 回給「你爸媽是做什麼的」答非所問，也被記成一個正常的攔截。answerSummary 照其他攔截存原答（後台要看得到漏了什麼）。
          const reply =
            continuing ??
            (finished.kind === "grounding"
              ? UNGROUNDED_REPLY
              : finished.kind === "privacy"
                ? PRIVACY_REPLY
                : finished.kind === "leak"
                  ? FALLBACK_REPLY
                  : GUARDED_REPLY);
          if (finished.kind === "leak") failed = true;
          controller.enqueue(encoder.encode(reply));
        } else if (!finished.text.trim()) {
          // 🔴 模型回了零個字（原因由 lib/gemini-chat.ts 印成 warn：finishReason／blockReason）。
          // 正式站實測：「妳是同性戀嗎」回 HTTP 200、內容是空字串——訪客看到一個空白泡泡；
          // 後台近 30 天有 2 筆 answer_summary 是空字串、in_scope=true、blocked=false、failed=false。
          // 空字串短於落地檢查的最低字數，護欄會直接放行，所以只能在這裡接。
          //
          // 回 UNGROUNDED_REPLY：對訪客來說這一題就是答不上來，那句至少給了下一步。
          // 🔴 一定要標 failed：空白回答是系統異常，不是一個回答。不標的話後台會把它當成一個
          // 正常回答（之前那 2 筆就是這樣），沒有人會去查。answerSummary 存訪客實際看到的那句，
          // 跟下面生成失敗時存 FALLBACK_REPLY 同一個作法。延續中改送同一句危機回覆（failed 照標）。
          const emptyReply = continuing ?? UNGROUNDED_REPLY;
          controller.enqueue(encoder.encode(emptyReply));
          answer = emptyReply;
          failed = true;
        }
      } catch (err) {
        console.error("[chat] 生成失敗：", err);
        // 延續中生成失敗也送同一句危機回覆：對正在求助的人，「請稍後再試」比重講一次專線更糟。
        const failReply = continuing ?? FALLBACK_REPLY;
        controller.enqueue(encoder.encode(failReply));
        answer = failReply;
        // 🔴 一定要標。不標的話這一筆在資料庫裡跟一個成功的回答完全一樣，
        // 後台會把「API 掛了」讀成「語料答得不好」。
        failed = true;
      }

      // ⚠️ 一定要先 await 記錄再 close。
      // Sunny 原版順序相反，serverless 會在回應結束後凍結實例，寫入可能永遠不會完成。
      try {
        await logInteraction({
          sessionId,
          questionText: question,
          answerSummary: answer,
          topSimilarity: result.topSimilarity,
          inScope: true,
          blocked,
          failed,
          channel,
        });
      } catch (err) {
        console.error("[chat] 記錄失敗：", err);
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Retrieval-Scope": "in",
    },
  });
}
