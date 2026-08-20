import { describe, it, expect } from "vitest";
import { sniffAudioContainer } from "./audio-format";

/**
 * ⚠️ 這支取代了原本 parseWavHeader 在 /api/stt 扮演的守門角色。
 * 那道門的目的從來不是「解析 WAV」，是「不要把垃圾送去 Gemini 付錢」，
 * 所以改用 MediaRecorder 之後這個責任要有人接。
 */

function bytes(...parts: (string | number[])[]): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      for (let i = 0; i < part.length; i++) out.push(part.charCodeAt(i));
    } else out.push(...part);
  }
  return Uint8Array.from(out);
}

describe("sniffAudioContainer", () => {
  it("Chrome 的 webm（EBML 標頭）", () => {
    expect(sniffAudioContainer(bytes([0x1a, 0x45, 0xdf, 0xa3], "webmdata"))).toBe("audio/webm");
  });

  it("Firefox 的 ogg", () => {
    expect(sniffAudioContainer(bytes("OggS", [0, 2, 0, 0, 0, 0, 0, 0]))).toBe("audio/ogg");
  });

  it("Safari 的 mp4（第 4 個位元組起是 ftyp）", () => {
    expect(sniffAudioContainer(bytes([0, 0, 0, 0x20], "ftypM4A "))).toBe("audio/mp4");
  });

  it("WAV 仍然認得（手動上傳、舊版客戶端）", () => {
    expect(sniffAudioContainer(bytes("RIFF", [36, 0, 0, 0], "WAVEfmt "))).toBe("audio/wav");
  });

  it("🔴 純文字要擋下來——那正是「腳本 POST 垃圾讓我們付錢」的樣子", () => {
    expect(sniffAudioContainer(bytes("這不是音訊只是一段中文字而已"))).toBeNull();
  });

  it("🔴 全 0 也要擋下來", () => {
    expect(sniffAudioContainer(new Uint8Array(2048))).toBeNull();
  });

  it("太短的一律不認，不要讀到界外", () => {
    expect(sniffAudioContainer(new Uint8Array(0))).toBeNull();
    expect(sniffAudioContainer(bytes([0x1a, 0x45, 0xdf, 0xa3]))).toBeNull();
  });

  it("⚠️ 只看開頭，不看 Content-Type——標頭寫什麼都不算數", () => {
    // 宣告成 webm 的 ogg 檔，仍然要被認成 ogg
    expect(sniffAudioContainer(bytes("OggS", [0, 2, 0, 0, 0, 0, 0, 0]))).toBe("audio/ogg");
  });
});
