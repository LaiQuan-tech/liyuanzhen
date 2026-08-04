import { describe, it, expect } from "vitest";
import { checkAnswer, stripMarkdown, createGuardedWriter } from "./answer-guard";

describe("checkAnswer", () => {
  it("政黨表態要被攔下來", () => {
    expect(checkAnswer("我支持民進黨的性平政策").blocked).toBe(true);
  });

  it("以本人身分做出新承諾要被攔下來", () => {
    expect(checkAnswer("我承諾未來會繼續推動修法").blocked).toBe(true);
  });

  it("虛構的新書售價要被攔下來", () => {
    expect(checkAnswer("新書定價：480 元").blocked).toBe(true);
  });

  it("正常的史實敘述不能誤攔", () => {
    const text = "1987 年，婦女新知從雜誌社改組為基金會，我擔任第一任董事長。";
    expect(checkAnswer(text).blocked).toBe(false);
  });
});

describe("stripMarkdown", () => {
  it("清掉粗體與標題符號——語音會把它們唸出來", () => {
    expect(stripMarkdown("**婦女新知**基金會")).toBe("婦女新知基金會");
    expect(stripMarkdown("## 標題")).toBe("標題");
  });

  it("清掉清單符號", () => {
    expect(stripMarkdown("- 第一點")).toBe("第一點");
  });
});

describe("createGuardedWriter", () => {
  it("串流內容最終會完整輸出", () => {
    const out: string[] = [];
    const writer = createGuardedWriter(
      (t) => out.push(t),
      () => {}
    );
    const text = "1982 年創辦婦女新知雜誌社。".repeat(6);
    for (const ch of text) writer.push(ch);
    const result = writer.finish();

    expect(result.blocked).toBe(false);
    expect(out.join("")).toBe(text);
  });

  it("跨 delta 邊界的封鎖字串也要抓得到", () => {
    const out: string[] = [];
    let blockedWith = "";
    const writer = createGuardedWriter(
      (t) => out.push(t),
      (m) => {
        blockedWith = m;
      }
    );
    // 「民進黨」被切成三個 delta 送進來
    writer.push("我覺得民");
    writer.push("進");
    writer.push("黨很好");
    writer.finish();

    expect(blockedWith).toBe("民進黨");
  });

  it("被攔截後不再吐出任何內容", () => {
    const out: string[] = [];
    const writer = createGuardedWriter(
      (t) => out.push(t),
      () => {}
    );
    writer.push("我支持國民黨");
    writer.push("接下來還有很多字".repeat(20));
    const result = writer.finish();

    expect(result.blocked).toBe(true);
    expect(out.join("")).toBe("");
  });
});
