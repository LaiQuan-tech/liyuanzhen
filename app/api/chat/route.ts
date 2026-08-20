import type { NextRequest } from "next/server";
import { retrieve } from "@/lib/retrieval";
import { streamChatResponse } from "@/lib/gemini-chat";
import { createGuardedWriter } from "@/lib/answer-guard";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { logInteraction } from "@/lib/interaction-log";
import { OUT_OF_SCOPE_REPLY, GUARDED_REPLY } from "@/content/site";
import type { HistoryTurn } from "@/lib/query-expansion";

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

const FALLBACK_REPLY = "抱歉，我這邊出了點狀況，請稍後再試一次。";

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

export async function POST(request: NextRequest) {
  if (!originAllowed(request)) {
    return textResponse("請從本網站發起提問。", 403);
  }

  const verdict = rateLimit(clientIp(request.headers));
  if (!verdict.ok) {
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

  const { sessionId, messages } = (body ?? {}) as {
    sessionId?: unknown;
    messages?: unknown;
  };

  if (typeof sessionId !== "string" || !Array.isArray(messages) || messages.length === 0) {
    return textResponse("請求格式錯誤。", 400);
  }

  const turns: HistoryTurn[] = messages
    .slice(-MAX_MESSAGES)
    .filter(
      (m): m is HistoryTurn =>
        !!m &&
        typeof (m as HistoryTurn).text === "string" &&
        ((m as HistoryTurn).role === "user" || (m as HistoryTurn).role === "model")
    );

  const last = turns[turns.length - 1];
  if (!last || last.role !== "user" || !last.text.trim()) {
    return textResponse("請求格式錯誤。", 400);
  }

  const question = last.text.trim().slice(0, MAX_MESSAGE_CHARS);
  const history = turns.slice(0, -1);

  // 檢索失敗要軟性降級，不能讓整個對話掛掉
  let result;
  try {
    result = await retrieve(question, history);
  } catch (err) {
    console.error("[chat] 檢索失敗：", err);
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
  if (!result.inScope) {
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(OUT_OF_SCOPE_REPLY));
        try {
          await logInteraction({
            sessionId,
            questionText: question,
            answerSummary: OUT_OF_SCOPE_REPLY,
            topSimilarity: result.topSimilarity,
            inScope: false,
            blocked: false,
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
        "X-Retrieval-Scope": "out",
      },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      let answer = "";
      let blocked = false;

      const writer = createGuardedWriter(
        (text) => controller.enqueue(encoder.encode(text)),
        (matched) => {
          blocked = true;
          console.warn("[chat] 輸出護欄攔截：", matched);
        }
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
        if (finished.blocked || blocked) {
          blocked = true;
          controller.enqueue(encoder.encode(GUARDED_REPLY));
        }
      } catch (err) {
        console.error("[chat] 生成失敗：", err);
        controller.enqueue(encoder.encode(FALLBACK_REPLY));
        answer = FALLBACK_REPLY;
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
