import { describe, it, expect } from "vitest";
import {
  chunkPcm,
  pcmDurationSeconds,
  looksLikeWav,
  BYTES_PER_SECOND,
  BYTES_PER_SAMPLE,
} from "./pcm";

/** 造一段長度為 n bytes 的假 PCM，內容是遞增值方便驗證切割沒有錯位 */
function fakePcm(bytes: number): Uint8Array {
  return Uint8Array.from({ length: bytes }, (_, i) => i % 256);
}

describe("chunkPcm", () => {
  it("一秒的音訊切成一塊", () => {
    expect(chunkPcm(fakePcm(BYTES_PER_SECOND))).toHaveLength(1);
  });

  it("兩秒半切成三塊，最後一塊是半秒", () => {
    const chunks = chunkPcm(fakePcm(BYTES_PER_SECOND * 2.5));
    expect(chunks).toHaveLength(3);
    expect(Buffer.from(chunks[2], "base64")).toHaveLength(BYTES_PER_SECOND / 2);
  });

  it("⚠️ 每塊都必須是偶數 bytes——奇數會把 16-bit 取樣切開，整段變雜訊", () => {
    for (const ms of [1000, 333, 777, 1]) {
      const chunks = chunkPcm(fakePcm(BYTES_PER_SECOND * 2), ms);
      // 除了最後一塊（受總長度限制），每塊都要對齊取樣邊界
      for (const chunk of chunks.slice(0, -1)) {
        expect(Buffer.from(chunk, "base64").length % BYTES_PER_SAMPLE).toBe(0);
      }
    }
  });

  it("接回去要跟原始資料逐位元相同（沒有掉 byte 也沒有重複）", () => {
    const source = fakePcm(BYTES_PER_SECOND * 3 + 17 * BYTES_PER_SAMPLE);
    const rejoined = Buffer.concat(
      chunkPcm(source).map((c) => Buffer.from(c, "base64"))
    );
    expect(rejoined).toEqual(Buffer.from(source));
  });

  it("空音訊回空陣列，不要回一塊空字串", () => {
    // 送空塊給 LiveAvatar 會被當成有效的 speak 事件，讓 avatar 做一次無聲的張嘴
    expect(chunkPcm(new Uint8Array(0))).toEqual([]);
  });

  it("chunkMs 傳 0 不會無限迴圈（保底一個取樣）", () => {
    const chunks = chunkPcm(fakePcm(10), 0);
    expect(chunks).toHaveLength(5);
  });

  it("每塊 base64 都遠小於 1 MB 的封包上限", () => {
    const chunks = chunkPcm(fakePcm(BYTES_PER_SECOND * 10));
    for (const chunk of chunks) expect(chunk.length).toBeLessThan(1_000_000);
  });
});

describe("pcmDurationSeconds", () => {
  it("48000 bytes 是一秒", () => {
    expect(pcmDurationSeconds(48_000)).toBe(1);
  });

  it("空的是零秒", () => {
    expect(pcmDurationSeconds(0)).toBe(0);
  });
});

describe("looksLikeWav", () => {
  it("⚠️ 抓得出被誤送成 WAV 的情況——那會讓每塊開頭爆音", () => {
    expect(looksLikeWav(Buffer.from("RIFF....WAVEfmt "))).toBe(true);
  });

  it("裸 PCM 不會誤判", () => {
    // 實測的 ElevenLabs pcm_24000 開頭：66 01 6f fd …
    expect(looksLikeWav(Uint8Array.from([0x66, 0x01, 0x6f, 0xfd]))).toBe(false);
  });

  it("太短的資料不會爆掉", () => {
    expect(looksLikeWav(Uint8Array.from([0x52, 0x49]))).toBe(false);
  });
});
