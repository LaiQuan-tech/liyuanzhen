import { describe, it, expect } from "vitest";
import {
  downsampleTo16k,
  floatToInt16,
  concatFloat32,
  encodeWav,
  chunksToWav,
  wavDurationSeconds,
  TARGET_SAMPLE_RATE,
  BYTES_PER_SAMPLE,
  WAV_HEADER_BYTES,
  parseWavHeader,
} from "./wav";

/** 造一段 n 秒的正弦波，用來驗降取樣沒有把訊號弄壞 */
function sine(seconds: number, rate: number, hz = 440): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.sin((2 * Math.PI * hz * i) / rate);
  }
  return out;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  // ⚠️ 不要寫成 String.fromCharCode(...bytes.subarray(...))——展開 typed array
  // 需要 downlevelIteration，tsconfig 沒開，會是 TS2802。
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe("downsampleTo16k", () => {
  it("48kHz 降成 16kHz，長度變三分之一", () => {
    const { samples, sampleRate } = downsampleTo16k(sine(1, 48_000), 48_000);
    expect(sampleRate).toBe(TARGET_SAMPLE_RATE);
    expect(samples.length).toBe(16_000);
  });

  it("44.1kHz 這種非整數倍也要能降", () => {
    const { samples, sampleRate } = downsampleTo16k(sine(1, 44_100), 44_100);
    expect(sampleRate).toBe(TARGET_SAMPLE_RATE);
    expect(samples.length).toBe(16_000);
  });

  it("已經是 16kHz 就原封不動", () => {
    const input = sine(0.5, 16_000);
    const { samples, sampleRate } = downsampleTo16k(input, 16_000);
    expect(samples).toBe(input);
    expect(sampleRate).toBe(16_000);
  });

  it("⚠️ 來源比目標低時不做假的升取樣，回報真實取樣率", () => {
    // 補出來的取樣沒有新資訊，卻會讓標頭與內容對不上——講話速度會變快
    const input = sine(0.5, 8_000);
    const { samples, sampleRate } = downsampleTo16k(input, 8_000);
    expect(samples).toBe(input);
    expect(sampleRate).toBe(8_000);
  });

  it("用區間平均而不是抽樣：直流訊號降完之後值不變", () => {
    const flat = new Float32Array(48_000).fill(0.5);
    const { samples } = downsampleTo16k(flat, 48_000);
    for (let i = 0; i < samples.length; i++) expect(samples[i]).toBeCloseTo(0.5, 6);
  });

  it("取樣率不合法要丟例外，不要靜靜產生壞資料", () => {
    expect(() => downsampleTo16k(new Float32Array(10), 0)).toThrow();
    expect(() => downsampleTo16k(new Float32Array(10), NaN)).toThrow();
  });
});

describe("floatToInt16", () => {
  it("⚠️ +1.0 不可以溢位——溢位會讓最大聲的地方變成反相爆音", () => {
    expect(floatToInt16(Float32Array.from([1]))[0]).toBe(32767);
  });

  it("-1.0 對到 Int16 的最小值", () => {
    expect(floatToInt16(Float32Array.from([-1]))[0]).toBe(-32768);
  });

  it("超出 [-1,1] 的值要夾住，不要繞回去", () => {
    const out = floatToInt16(Float32Array.from([2, -2, 99]));
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32768);
    expect(out[2]).toBe(32767);
  });

  it("靜音就是 0", () => {
    expect(Array.from(floatToInt16(new Float32Array(4)))).toEqual([0, 0, 0, 0]);
  });
});

describe("concatFloat32", () => {
  it("依序接起來，不漏也不重複", () => {
    const out = concatFloat32([
      Float32Array.from([1, 2]),
      Float32Array.from([3]),
      Float32Array.from([4, 5]),
    ]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it("空陣列回空的", () => {
    expect(concatFloat32([]).length).toBe(0);
  });
});

describe("encodeWav", () => {
  const wav = encodeWav(Int16Array.from([0, 1000, -1000, 32767]), 16_000);

  it("標頭長度固定 44 bytes", () => {
    expect(wav.length).toBe(WAV_HEADER_BYTES + 4 * BYTES_PER_SAMPLE);
  });

  it("三個 chunk 標記都在正確位置", () => {
    expect(readAscii(wav, 0, 4)).toBe("RIFF");
    expect(readAscii(wav, 8, 4)).toBe("WAVE");
    expect(readAscii(wav, 12, 4)).toBe("fmt ");
    expect(readAscii(wav, 36, 4)).toBe("data");
  });

  it("⚠️ 長度欄位是 little-endian，寫成大端整個檔案讀不出來", () => {
    const v = view(wav);
    expect(v.getUint32(4, true)).toBe(36 + 8); // 36 ＋ 資料長度
    expect(v.getUint32(40, true)).toBe(8); // 資料長度
  });

  it("格式欄位：PCM、單聲道、16-bit", () => {
    const v = view(wav);
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // 單聲道
    expect(v.getUint32(24, true)).toBe(16_000); // 取樣率
    expect(v.getUint32(28, true)).toBe(32_000); // byte rate ＝ 16000 × 1 × 2
    expect(v.getUint16(32, true)).toBe(2); // block align
    expect(v.getUint16(34, true)).toBe(16); // bits per sample
  });

  it("取樣值原封不動寫進去", () => {
    const v = view(wav);
    expect(v.getInt16(44, true)).toBe(0);
    expect(v.getInt16(46, true)).toBe(1000);
    expect(v.getInt16(48, true)).toBe(-1000);
    expect(v.getInt16(50, true)).toBe(32767);
  });

  it("標頭寫的取樣率要跟傳進來的一致，不是寫死 16000", () => {
    const low = encodeWav(Int16Array.from([0]), 8_000);
    expect(view(low).getUint32(24, true)).toBe(8_000);
  });
});

describe("chunksToWav", () => {
  it("48kHz 錄一秒 → 16kHz 的 WAV，長度算得出來", () => {
    const wav = chunksToWav([sine(1, 48_000)], 48_000);
    expect(readAscii(wav, 0, 4)).toBe("RIFF");
    expect(wav.length).toBe(WAV_HEADER_BYTES + 16_000 * BYTES_PER_SAMPLE);
    expect(wavDurationSeconds(wav.length)).toBeCloseTo(1, 3);
  });

  it("多塊接起來的結果跟一整塊一樣", () => {
    const whole = sine(0.5, 48_000);
    const split = [whole.subarray(0, 8_000), whole.subarray(8_000)];
    expect(Array.from(chunksToWav(split, 48_000))).toEqual(
      Array.from(chunksToWav([whole], 48_000))
    );
  });

  it("⚠️ 低取樣率來源的標頭要寫真實取樣率，否則播出來速度不對", () => {
    const wav = chunksToWav([sine(1, 8_000)], 8_000);
    expect(view(wav).getUint32(24, true)).toBe(8_000);
    expect(wavDurationSeconds(wav.length, 8_000)).toBeCloseTo(1, 3);
  });

  it("沒錄到東西也要產出合法的 WAV，不要炸掉", () => {
    const wav = chunksToWav([], 48_000);
    expect(wav.length).toBe(WAV_HEADER_BYTES);
    expect(readAscii(wav, 0, 4)).toBe("RIFF");
    expect(wavDurationSeconds(wav.length)).toBe(0);
  });
});

describe("parseWavHeader", () => {
  it("讀得出我們自己編的 WAV", () => {
    const wav = chunksToWav([sine(2, 48_000)], 48_000);
    const header = parseWavHeader(wav);
    expect(header).not.toBeNull();
    expect(header!.sampleRate).toBe(16_000);
    expect(header!.channels).toBe(1);
    expect(header!.bitsPerSample).toBe(16);
    expect(header!.durationSeconds).toBeCloseTo(2, 3);
  });

  it("⚠️ 時長要用標頭裡的取樣率算，不能假設 16000", () => {
    // 用錯取樣率算，「30 秒上限」會變成實際 60 秒
    const wav = chunksToWav([sine(2, 8_000)], 8_000);
    const header = parseWavHeader(wav)!;
    expect(header.sampleRate).toBe(8_000);
    expect(header.durationSeconds).toBeCloseTo(2, 3);
  });

  it("不是 WAV 的東西一律回 null——要在付錢給 Gemini 之前擋掉", () => {
    expect(parseWavHeader(new Uint8Array(0))).toBeNull();
    expect(parseWavHeader(new Uint8Array(10))).toBeNull();
    expect(parseWavHeader(new Uint8Array(200))).toBeNull(); // 全 0，沒有 RIFF
    expect(parseWavHeader(Uint8Array.from(Buffer.from("這是一段文字不是音訊".repeat(20))))).toBeNull();
  });

  it("RIFF 對但 WAVE 不對也要擋", () => {
    const wav = chunksToWav([sine(0.1, 16_000)], 16_000);
    wav[8] = 0x58; // WAVE → XAVE
    expect(parseWavHeader(wav)).toBeNull();
  });

  it("壓縮格式（audioFormat ≠ 1）要擋——我們只處理裸 PCM", () => {
    const wav = chunksToWav([sine(0.1, 16_000)], 16_000);
    new DataView(wav.buffer).setUint16(20, 3, true); // 3 ＝ IEEE float
    expect(parseWavHeader(wav)).toBeNull();
  });

  it("⚠️ 標頭宣告的長度比實際內容長時，取實際值——否則截斷的上傳會被高估時長", () => {
    const wav = chunksToWav([sine(5, 16_000)], 16_000);
    const truncated = wav.subarray(0, WAV_HEADER_BYTES + 16_000 * 2); // 只剩 1 秒的資料
    const header = parseWavHeader(truncated)!;
    expect(header.durationSeconds).toBeCloseTo(1, 3);
  });
});

describe("parseWavHeader：非標準區塊配置（回歸測試）", () => {
  /**
   * 造一個「fmt 與 data 中間插了別的區塊」的 WAV，就是 ffmpeg 產出的樣子。
   * 這正是實際踩到的 bug：假設 data 固定在 offset 36，於是一個 40 秒的檔案
   * 被算成 0 秒，繞過了 30 秒上限。
   */
  function wavWithExtraChunk(dataSamples: number, extraId = "LIST", extraSize = 26): Uint8Array {
    const dataBytes = dataSamples * 2;
    const extraPadded = extraSize + (extraSize % 2);
    const total = 12 + 24 + (8 + extraPadded) + (8 + dataBytes);
    const bytes = new Uint8Array(total);
    const view = new DataView(bytes.buffer);
    const put = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };

    put(0, "RIFF");
    view.setUint32(4, total - 8, true);
    put(8, "WAVE");

    put(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // 單聲道
    view.setUint32(24, 16_000, true);
    view.setUint32(28, 32_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);

    let offset = 36;
    put(offset, extraId);
    view.setUint32(offset + 4, extraSize, true);
    offset += 8 + extraPadded;

    put(offset, "data");
    view.setUint32(offset + 4, dataBytes, true);
    return bytes;
  }

  it("⚠️ fmt 與 data 中間插了 LIST 區塊，時長仍要算對", () => {
    // 40 秒 @ 16kHz。舊版解析器會把它算成 0 秒，於是繞過 30 秒上限。
    const header = parseWavHeader(wavWithExtraChunk(16_000 * 40));
    expect(header).not.toBeNull();
    expect(header!.sampleRate).toBe(16_000);
    expect(header!.durationSeconds).toBeCloseTo(40, 1);
  });

  it("奇數長度的區塊有 padding byte，之後的區塊不可以錯位", () => {
    const header = parseWavHeader(wavWithExtraChunk(16_000 * 3, "LIST", 25));
    expect(header).not.toBeNull();
    expect(header!.durationSeconds).toBeCloseTo(3, 1);
  });

  it("⚠️ 造假的區塊長度不可以造成無窮迴圈或溢位", () => {
    const bogus = wavWithExtraChunk(1600, "LIST", 26);
    // 把那個區塊的長度改成天文數字
    new DataView(bogus.buffer).setUint32(40, 0xffffffff, true);
    // 要嘛回 null 要嘛正常回傳，就是不可以卡住
    expect(() => parseWavHeader(bogus)).not.toThrow();
    expect(parseWavHeader(bogus)).toBeNull();
  });

  it("長度為 0 的區塊也不可以造成無窮迴圈", () => {
    const bogus = wavWithExtraChunk(1600, "LIST", 26);
    new DataView(bogus.buffer).setUint32(40, 0, true);
    expect(() => parseWavHeader(bogus)).not.toThrow();
  });

  it("找不到 data 區塊要回 null，不要當成 0 秒的合法檔案", () => {
    const noData = wavWithExtraChunk(0, "LIST", 26).subarray(0, 44);
    expect(parseWavHeader(noData)).toBeNull();
  });
});
