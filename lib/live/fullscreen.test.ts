import { describe, it, expect, vi } from "vitest";
import {
  isFullscreenSupported,
  isDocumentFullscreen,
  requestFullscreenOn,
  exitFullscreenOn,
  toggleFullscreen,
  fullscreenButtonLabel,
  FULLSCREEN_ENTER_LABEL,
  FULLSCREEN_EXIT_LABEL,
} from "./fullscreen";

describe("isFullscreenSupported", () => {
  it("標準 API 存在、fullscreenEnabled 沒被關掉 → true", () => {
    expect(
      isFullscreenSupported({
        fullscreenEnabled: true,
        documentElement: { requestFullscreen: () => Promise.resolve() },
      })
    ).toBe(true);
  });

  it("只有 webkit 前綴（舊版 Safari）也算支援", () => {
    expect(
      isFullscreenSupported({ documentElement: { webkitRequestFullscreen: () => {} } })
    ).toBe(true);
  });

  it("沒有 fullscreenEnabled 這個欄位（很舊的純 webkit 瀏覽器）不當作不支援", () => {
    // ⚠️ 只擋明確的 false，讀不到這個較新的屬性不能當成不支援的理由。
    expect(
      isFullscreenSupported({ documentElement: { requestFullscreen: () => Promise.resolve() } })
    ).toBe(true);
  });

  it("🔴 iPhone Safari 的一種長法：完全沒有 requestFullscreen → false，按鈕不該出現", () => {
    expect(isFullscreenSupported({ documentElement: {} })).toBe(false);
    expect(isFullscreenSupported({ documentElement: null })).toBe(false);
    expect(isFullscreenSupported(undefined)).toBe(false);
  });

  it("🔴 iPhone Safari 的另一種長法：方法存在，但 fullscreenEnabled 明講 false → false", () => {
    expect(
      isFullscreenSupported({
        fullscreenEnabled: false,
        documentElement: { requestFullscreen: () => Promise.resolve() },
      })
    ).toBe(false);
  });
});

describe("isDocumentFullscreen", () => {
  it("標準的 fullscreenElement 有值 → true", () => {
    expect(isDocumentFullscreen({ fullscreenElement: {} })).toBe(true);
  });

  it("webkit 後備：只有 webkitFullscreenElement 有值也算 true", () => {
    expect(isDocumentFullscreen({ webkitFullscreenElement: {} })).toBe(true);
  });

  it("兩個都沒有、或整個 doc 都沒有 → false", () => {
    expect(isDocumentFullscreen({})).toBe(false);
    expect(isDocumentFullscreen({ fullscreenElement: null })).toBe(false);
    expect(isDocumentFullscreen(undefined)).toBe(false);
  });
});

describe("requestFullscreenOn", () => {
  it("標準 API 存在時，帶 navigationUI: hide 呼叫它，不呼叫 webkit 後備", async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const webkitRequestFullscreen = vi.fn().mockResolvedValue(undefined);
    await requestFullscreenOn({ requestFullscreen, webkitRequestFullscreen });
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(requestFullscreen).toHaveBeenCalledWith({ navigationUI: "hide" });
    expect(webkitRequestFullscreen).not.toHaveBeenCalled();
  });

  it("沒有標準 API 時退到 webkitRequestFullscreen", async () => {
    const webkitRequestFullscreen = vi.fn().mockResolvedValue(undefined);
    await requestFullscreenOn({ webkitRequestFullscreen });
    expect(webkitRequestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("🔴 reject 要被吞掉，不可以讓錯誤冒出去影響頁面", async () => {
    const requestFullscreen = vi.fn().mockRejectedValue(new Error("不在使用者手勢裡呼叫"));
    await expect(requestFullscreenOn({ requestFullscreen })).resolves.toBeUndefined();
  });

  it("完全沒有方法、或沒有元素 → 什麼都不做，也不丟錯", async () => {
    await expect(requestFullscreenOn({})).resolves.toBeUndefined();
    await expect(requestFullscreenOn(undefined)).resolves.toBeUndefined();
  });
});

describe("exitFullscreenOn", () => {
  it("標準 API 存在時呼叫它，不呼叫 webkit 後備", async () => {
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    const webkitExitFullscreen = vi.fn().mockResolvedValue(undefined);
    await exitFullscreenOn({ exitFullscreen, webkitExitFullscreen });
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(webkitExitFullscreen).not.toHaveBeenCalled();
  });

  it("沒有標準 API 時退到 webkitExitFullscreen", async () => {
    const webkitExitFullscreen = vi.fn().mockResolvedValue(undefined);
    await exitFullscreenOn({ webkitExitFullscreen });
    expect(webkitExitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("🔴 reject 要被吞掉", async () => {
    const exitFullscreen = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(exitFullscreenOn({ exitFullscreen })).resolves.toBeUndefined();
  });

  it("完全沒有方法、或沒有 doc → 什麼都不做，也不丟錯", async () => {
    await expect(exitFullscreenOn({})).resolves.toBeUndefined();
    await expect(exitFullscreenOn(undefined)).resolves.toBeUndefined();
  });
});

describe("toggleFullscreen", () => {
  it("目前不是全螢幕 → 呼叫 requestFullscreen，不呼叫 exitFullscreen", async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    await toggleFullscreen({ requestFullscreen }, { exitFullscreen, fullscreenElement: null });
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(exitFullscreen).not.toHaveBeenCalled();
  });

  it("目前是全螢幕 → 呼叫 exitFullscreen，不呼叫 requestFullscreen", async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    await toggleFullscreen({ requestFullscreen }, { exitFullscreen, fullscreenElement: {} });
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it("webkit 後備下也能正確判斷目前狀態並呼叫對的函式", async () => {
    const webkitRequestFullscreen = vi.fn().mockResolvedValue(undefined);
    const webkitExitFullscreen = vi.fn().mockResolvedValue(undefined);
    await toggleFullscreen(
      { webkitRequestFullscreen },
      { webkitExitFullscreen, webkitFullscreenElement: {} }
    );
    expect(webkitExitFullscreen).toHaveBeenCalledTimes(1);
    expect(webkitRequestFullscreen).not.toHaveBeenCalled();
  });

  it("🔴 兩邊的 reject 都要被吞掉，toggle 本身絕不能拋錯", async () => {
    const requestFullscreen = vi.fn().mockRejectedValue(new Error("進入失敗"));
    const exitFullscreen = vi.fn().mockRejectedValue(new Error("離開失敗"));
    await expect(
      toggleFullscreen({ requestFullscreen }, { exitFullscreen, fullscreenElement: null })
    ).resolves.toBeUndefined();
    await expect(
      toggleFullscreen({ requestFullscreen }, { exitFullscreen, fullscreenElement: {} })
    ).resolves.toBeUndefined();
  });
});

describe("fullscreenButtonLabel", () => {
  it("非全螢幕 → 全螢幕", () => {
    expect(fullscreenButtonLabel(false)).toBe(FULLSCREEN_ENTER_LABEL);
    expect(fullscreenButtonLabel(false)).toBe("全螢幕");
  });

  it("全螢幕中 → 離開全螢幕", () => {
    expect(fullscreenButtonLabel(true)).toBe(FULLSCREEN_EXIT_LABEL);
    expect(fullscreenButtonLabel(true)).toBe("離開全螢幕");
  });
});
