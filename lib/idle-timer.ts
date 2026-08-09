/**
 * 從 Sunny 展場版搬過來的閒置計時器（零依賴、零框架）。
 *
 * 展場只需要「沒人操作就收掉」，網站還要多防幾件事——分頁被切到背景、
 * 使用者離開頁面——那些由 AvatarStage 另外掛，這裡只負責純粹的倒數。
 */

export interface IdleTimer {
  start(): void;
  reportActivity(): void;
  stop(): void;
}

export function createIdleTimer(timeoutMs: number, onIdle: () => void): IdleTimer {
  let handle: ReturnType<typeof setTimeout> | null = null;

  function clear() {
    if (handle !== null) {
      clearTimeout(handle);
      handle = null;
    }
  }

  function schedule() {
    clear();
    handle = setTimeout(onIdle, timeoutMs);
  }

  return {
    start: schedule,
    reportActivity: schedule,
    stop: clear,
  };
}
