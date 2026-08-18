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
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
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
    for (const value of samples) expect(value).toBeCloseTo(0.5, 6);
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
