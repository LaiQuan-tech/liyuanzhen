import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createIdleTimer } from "./idle-timer";

describe("createIdleTimer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("時間到才觸發", () => {
    const onIdle = vi.fn();
    createIdleTimer(1000, onIdle).start();

    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("沒 start 就不會自己跑", () => {
    const onIdle = vi.fn();
    createIdleTimer(1000, onIdle);

    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("有互動就重新計時", () => {
    const onIdle = vi.fn();
    const timer = createIdleTimer(1000, onIdle);
    timer.start();

    vi.advanceTimersByTime(900);
    timer.reportActivity();
    vi.advanceTimersByTime(900);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("⚠️ 連續互動只會留下一個計時器，不會累積出多次觸發", () => {
    const onIdle = vi.fn();
    const timer = createIdleTimer(1000, onIdle);
    timer.start();

    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(100);
      timer.reportActivity();
    }

    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("stop() 之後不會再觸發——離開頁面時燒錢的 session 必須真的收掉", () => {
    const onIdle = vi.fn();
    const timer = createIdleTimer(1000, onIdle);
    timer.start();
    timer.stop();

    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("stop() 可重複呼叫", () => {
    const timer = createIdleTimer(1000, vi.fn());
    timer.start();
    expect(() => {
      timer.stop();
      timer.stop();
    }).not.toThrow();
  });
});
