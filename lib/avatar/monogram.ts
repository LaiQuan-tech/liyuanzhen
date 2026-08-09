import { Speaker } from "../tts";
import type { AvatarDriver, AvatarDriverHooks } from "./types";

/**
 * 現況的 driver：圓形「李」字標記 ＋ 瀏覽器內建 TTS。
 *
 * 它同時是**所有其他 driver 的退路**，所以這個檔案的可靠性要求比 heygen 還高：
 * 不連外、不需帳號、不會計費，任何情況下都必須能跑起來。
 * 唯一會失敗的情形是裝置沒有中文語音，而那不是致命錯誤——
 * 文字聊天照常運作，只是不發聲，audioAvailable 會回報 false。
 */
export function createMonogramDriver(hooks: AvatarDriverHooks): AvatarDriver {
  const speaker = new Speaker();
  let available = false;
  let prepared = false;
  let dead = false;

  return {
    provider: "monogram",
    needsVideo: false,
    metered: false, // 瀏覽器內建 TTS，不花錢也沒有遠端 session 要收
    get audioAvailable() {
      return available;
    },

    async prepare() {
      if (prepared || dead) return;
      prepared = true;
      // Speaker 只回報它自己知道的事：有沒有在發聲。thinking 由呼叫端的 busy 推導。
      available = await speaker.init((state) =>
        hooks.onSpeakingChange(state === "speaking")
      );
    },

    push(delta) {
      if (dead || !available) return;
      speaker.push(delta);
    },

    finish() {
      // 逐句朗讀：串流過程中大部分已經唸掉了，這裡只把殘留的最後一句收尾。
      // 不用 fullText——monogram 沒有 GUARDED_REPLY 的回收問題，因為它逐句
      // 唸出去的當下，answer-guard 尚未判定封鎖；真正要防的是 heygen 那種
      // 「等整段再開口」的 driver 把被回收的段落也唸出來。
      if (dead || !available) return;
      speaker.flush();
    },

    stop() {
      if (dead) return;
      speaker.stop(); // stop() 自己會發 onState("idle")
      speaker.reset(); // 解除鎖定，下一題才能繼續唸
    },

    async destroy() {
      dead = true;
      speaker.stop();
    },
  };
}
