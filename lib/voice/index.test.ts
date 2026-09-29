import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { synthesize, synthesizeStream } from "./index";

/**
 * 🔴 2026-09-29：送給 ElevenLabs 的 body 要帶 voice_settings.stability = 1.0。
 * 不帶的話，同一次合成會中途換音色（/live4 正式站錄影：前段沙啞蒼老、從「在淡江教書」起變清亮年輕），
 * 見 lib/voice/index.ts 的 VOICE_SETTINGS。兩支合成函式（串流、整段）都要帶。
 */
describe("ElevenLabs 請求的 voice_settings", () => {
  const bodies: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    bodies.length = 0;
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    vi.stubEnv("ELEVENLABS_VOICE_ID", "test-voice");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        // 4 個取樣的裸 PCM（不是 WAV 檔頭），兩支函式都吃得下
        return new Response(new Uint8Array([0, 0, 1, 0, 2, 0, 3, 0]), { status: 200 });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("串流版帶 stability 1.0 與原本的模型", async () => {
    await synthesizeStream("我在 1982 年和朋友一起辦了《婦女新知》。");
    expect(bodies).toHaveLength(1);
    expect(bodies[0].model_id).toBe("eleven_v3_conversational");
    expect(bodies[0].voice_settings).toEqual({ stability: 1.0 });
  });

  it("整段版也帶 stability 1.0", async () => {
    await synthesize("我在 1982 年和朋友一起辦了《婦女新知》。");
    expect(bodies).toHaveLength(1);
    expect(bodies[0].voice_settings).toEqual({ stability: 1.0 });
  });
});
