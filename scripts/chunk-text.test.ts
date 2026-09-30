import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chunkMarkdown, ExcludeMarkerError, parseFrontMatter, stripExcluded } from "./chunk-text";

const META = { source: "test", sourceUrl: "https://example.com", docTitle: "測試文件" };

describe("parseFrontMatter", () => {
  it("解析 front-matter 並回傳剩餘內文", () => {
    const { meta, body } = parseFrontMatter(
      "---\nsource: 維基百科\nsourceUrl: https://zh.wikipedia.org/x\ntitle: 生平\n---\n內文開始"
    );
    expect(meta.source).toBe("維基百科");
    expect(meta.sourceUrl).toBe("https://zh.wikipedia.org/x");
    expect(meta.docTitle).toBe("生平");
    expect(body.trim()).toBe("內文開始");
  });

  it("沒有 front-matter 時原樣回傳", () => {
    const { meta, body } = parseFrontMatter("直接就是內文");
    expect(meta).toEqual({});
    expect(body).toBe("直接就是內文");
  });
});

describe("chunkMarkdown", () => {
  it("每塊的 embedInput 都要掛上標題麵包屑", () => {
    const chunks = chunkMarkdown("## 創辦經過\n\n一段內容。", META);
    expect(chunks[0].embedInput).toContain("【測試文件 · 創辦經過】");
    expect(chunks[0].content).toBe("一段內容。");
    expect(chunks[0].title).toBe("測試文件 · 創辦經過");
  });

  it("超過 maxChars 會切開，且相鄰塊要有重疊", () => {
    const para = (n: number) => `第${n}段：${"字".repeat(60)}`;
    const md = `## 節\n\n${para(1)}\n\n${para(2)}\n\n${para(3)}\n\n${para(4)}`;
    const chunks = chunkMarkdown(md, META, { maxChars: 140, overlapParagraphs: 1 });

    expect(chunks.length).toBeGreaterThan(1);
    // 重疊：後一塊的開頭應該包含前一塊的最後一段
    const prevLast = chunks[0].content.split("\n\n").pop()!;
    expect(chunks[1].content).toContain(prevLast);
  });

  it("overlapParagraphs 設 0 就不重疊", () => {
    const para = (n: number) => `第${n}段：${"字".repeat(60)}`;
    const md = `## 節\n\n${para(1)}\n\n${para(2)}\n\n${para(3)}`;
    const chunks = chunkMarkdown(md, META, { maxChars: 140, overlapParagraphs: 0 });
    const prevLast = chunks[0].content.split("\n\n").pop()!;
    expect(chunks[1].content).not.toContain(prevLast);
  });

  it("front-matter 的 source/sourceUrl 會覆蓋 fallback", () => {
    const chunks = chunkMarkdown(
      "---\nsource: 婦女新知\nsourceUrl: https://awakening.org.tw\n---\n## 節\n\n內容",
      META
    );
    expect(chunks[0].source).toBe("婦女新知");
    expect(chunks[0].sourceUrl).toBe("https://awakening.org.tw");
  });

  it("不同標題的內容不會被混進同一塊", () => {
    const chunks = chunkMarkdown("## A\n\n甲內容\n\n## B\n\n乙內容", META);
    const a = chunks.find((c) => c.title.includes("A"));
    const b = chunks.find((c) => c.title.includes("B"));
    expect(a?.content).toBe("甲內容");
    expect(b?.content).toBe("乙內容");
  });
});

/**
 * ai:exclude：在世者的近況（健康、照顧安排、女兒近年生活）不進檢索。
 * 書的文字一字不改，只在切塊前把標記之間的行丟掉；標記寫錯要讓 build:index 失敗，
 * 因為寫錯的標記不會被認出來，那段就安靜地進了 AI。
 */
describe("ai:exclude 排除區", () => {
  const OPEN = "<!-- ai:exclude 老師近年的健康 -->";
  const CLOSE = "<!-- /ai:exclude -->";
  const all = (md: string, file?: string) =>
    chunkMarkdown(md, META, { fileName: file })
      .map((c) => `${c.title}\n${c.embedInput}\n${c.content}`)
      .join("\n");

  it("成對：標記之間的內文與標記本身都不進任何塊，前後內文照常", () => {
    const md = `## 近況\n\n她退休後寫作。\n\n${OPEN}\n她跌倒受傷。\n\n她記憶退化。\n${CLOSE}\n\n她出席新書發表會。`;
    const text = all(md);
    expect(text).not.toContain("跌倒");
    expect(text).not.toContain("記憶退化");
    expect(text).not.toContain("ai:exclude");
    expect(text).not.toContain("<!--");
    expect(text).toContain("她退休後寫作。");
    expect(text).toContain("她出席新書發表會。");
  });

  it("回報每個排除區的行號、理由與字數（行號含 front-matter，就是檔案裡的行號）", () => {
    const md = `---\nsource: 測試\n---\n## 節\n\n前文\n\n${OPEN}\n甲乙丙\n\n丁戊\n${CLOSE}\n\n後文`;
    const { excluded } = stripExcluded(md, "x.md");
    expect(excluded).toEqual([{ startLine: 8, endLine: 12, reason: "老師近年的健康", chars: 5 }]);
  });

  it("標記外的文字不受影響：結果跟這段從來不存在時一模一樣", () => {
    const withBlock = `## A\n\n甲一。\n\n${OPEN}\n不該出現。\n${CLOSE}\n\n甲二。\n\n## B\n\n乙。`;
    const without = "## A\n\n甲一。\n\n甲二。\n\n## B\n\n乙。";
    expect(chunkMarkdown(withBlock, META)).toEqual(chunkMarkdown(without, META));
  });

  it("標記緊貼段落（沒有空行）時，前後兩段也不會被黏成同一段", () => {
    const md = `## A\n\n前段。\n${OPEN}\n不該出現。\n${CLOSE}\n後段。`;
    const chunks = chunkMarkdown(md, META);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("前段。\n\n後段。");
  });

  it("標題結構不被破壞：排除區後面的內文留在原來的小節，下一節不受影響", () => {
    const md = `## 航向另一個港\n\n${OPEN}\n她跌倒。\n${CLOSE}\n\n回顧這一生，港城之間。\n\n## 下一節\n\n下一節內文。`;
    const chunks = chunkMarkdown(md, META);
    expect(chunks.map((c) => [c.title, c.content])).toEqual([
      ["測試文件 · 航向另一個港", "回顧這一生，港城之間。"],
      ["測試文件 · 下一節", "下一節內文。"],
    ]);
  });

  it("整節內容都被排除時，只剩標題的小節不產生任何塊", () => {
    const md = `## 只有近況\n\n${OPEN}\n她跌倒。\n${CLOSE}\n\n## 童年\n\n鑽鐵絲網溜出去玩。`;
    const chunks = chunkMarkdown(md, META);
    expect(chunks.map((c) => c.title)).toEqual(["測試文件 · 童年"]);
  });

  it("排除區裡有標題行就報錯（丟掉標題會讓後面的內文掛錯出處）", () => {
    const md = `## A\n\n${OPEN}\n## B\n內文\n${CLOSE}`;
    expect(() => chunkMarkdown(md, META, { fileName: "10-x.md" })).toThrow(ExcludeMarkerError);
    expect(() => chunkMarkdown(md, META, { fileName: "10-x.md" })).toThrow("10-x.md:4:");
  });

  it("巢狀：報錯並指出內層開始標記的檔名與行號", () => {
    const md = `## A\n\n${OPEN}\n甲\n${OPEN}\n乙\n${CLOSE}\n${CLOSE}`;
    expect(() => chunkMarkdown(md, META, { fileName: "10-x.md" })).toThrow(/^10-x\.md:5: .*巢狀/);
  });

  it("不成對：只有開始標記，報開始標記那一行", () => {
    const md = `## A\n\n前文\n\n${OPEN}\n甲`;
    expect(() => chunkMarkdown(md, META, { fileName: "10-x.md" })).toThrow(/^10-x\.md:5: .*沒有對應的結束標記/);
  });

  it("不成對：多出一個結束標記，報那一行", () => {
    const md = `## A\n\n甲\n${CLOSE}`;
    expect(() => chunkMarkdown(md, META, { fileName: "10-x.md" })).toThrow(/^10-x\.md:4: .*前面沒有對應的開始標記/);
  });

  it("開始標記沒寫理由就報錯", () => {
    const md = `## A\n\n<!-- ai:exclude -->\n甲\n${CLOSE}`;
    expect(() => chunkMarkdown(md, META, { fileName: "10-x.md" })).toThrow(/^10-x\.md:3: .*要寫理由/);
  });

  it("標記沒有獨占一行（或寫錯）就報錯，不會安靜地讓那段進 AI", () => {
    expect(() => chunkMarkdown(`## A\n\n前文 ${OPEN}\n甲\n${CLOSE}`, META, { fileName: "10-x.md" })).toThrow(/^10-x\.md:3: .*不是合格的標記/);
    expect(() => chunkMarkdown(`## A\n\n<!-- ai:exclude 理由\n甲\n${CLOSE}`, META, { fileName: "10-x.md" })).toThrow(/^10-x\.md:3: .*不是合格的標記/);
  });

  it("🔴 標記成對寫錯（大小寫、全形冒號、空白、連字號、零寬字元）也要報錯，不能兩個都認不出來就整段放行", () => {
    const pairs: [string, string][] = [
      ["<!-- AI:exclude 理由 -->", "<!-- /AI:exclude -->"],
      ["<!-- ai：exclude 理由 -->", "<!-- /ai：exclude -->"],
      ["<!-- ai: exclude 理由 -->", "<!-- /ai: exclude -->"],
      ["<!-- ai-exclude 理由 -->", "<!-- /ai-exclude -->"],
      ["<!-- ai:\u200Bexclude 理由 -->", "<!-- /ai:\u200Bexclude -->"],
    ];
    for (const [o, c] of pairs) {
      expect(() => chunkMarkdown(`## A\n\n${o}\n秘密\n${c}`, META, { fileName: "10-x.md" }), o).toThrow(/^10-x\.md:3: /);
    }
  });

  /**
   * 2026-09-28 獨立審查：開始與結束標記都寫成全形時，原本的兩道檢查（半形「<!--」、半形「ai…exclude」）
   * 都認不出來，排除區的文字就安靜地進了切塊。現在每一行先做 NFKC 正規化再判斷。
   * 前兩組是審查者實測漏掉的寫法；全形空白原本會被 `\s` 當成合格標記，現在一樣要報錯（標記只有一種寫法）。
   */
  it("🔴 全形寫的標記（NFKC 正規化後才看得出是標記）也要報錯，報在開始標記那一行", () => {
    const pairs: [string, string, string][] = [
      ["全形角括號、全形英文與冒號", "＜！－－ ａｉ：ｅｘｃｌｕｄｅ 理由 －－＞", "＜！－－ ／ａｉ：ｅｘｃｌｕｄｅ －－＞"],
      ["全形角括號、關鍵字拼錯", "＜！－－ ai:exlcude 理由 －－＞", "＜！－－ /ai:exlcude －－＞"],
      ["全形空白當分隔", "<!--\u3000ai:exclude\u3000理由\u3000-->", "<!--\u3000/ai:exclude\u3000-->"],
      ["全形空白在標記中間", "<!-- ai:\u3000exclude 理由 -->", "<!-- /ai:\u3000exclude -->"],
      ["全形冒號、全形角括號", "＜！－－ ai：exclude 理由 －－＞", "＜！－－ /ai：exclude －－＞"],
      ["全形冒號、半形角括號", "<!-- ai：exclude 理由 -->", "<!-- /ai：exclude -->"],
      ["只有連字號是全形", "<!－－ ai:exclude 理由 －－>", "<!－－ /ai:exclude －－>"],
      ["全形驚嘆號", "<！-- ai:exclude 理由 --＞", "<！-- /ai:exclude --＞"],
    ];
    for (const [label, o, c] of pairs) {
      const md = `## A\n\n${o}\n秘密\n${c}\n\n公開的內文`;
      expect(() => chunkMarkdown(md, META, { fileName: "10-x.md" }), label).toThrow(ExcludeMarkerError);
      expect(() => chunkMarkdown(md, META, { fileName: "10-x.md" }), label).toThrow(/^10-x\.md:3: .*不是合格的標記/);
    }
  });

  it("全形寫的標記：錯誤訊息印出正規化後的樣子，看得出是全形造成的", () => {
    const md = "## A\n\n＜！－－ ａｉ：ｅｘｃｌｕｄｅ 理由 －－＞\n秘密\n＜！－－ ／ａｉ：ｅｘｃｌｕｄｅ －－＞";
    expect(() => chunkMarkdown(md, META, { fileName: "10-x.md" })).toThrow(
      "正規化後是「<!-- ai:exclude 理由 -->」"
    );
  });

  it("只有結束標記寫成全形：報在結束標記那一行（不會被當成不成對而報到別處，也不會放行）", () => {
    const md = `## A\n\n${OPEN}\n秘密\n＜！－－ ／ａｉ：ｅｘｃｌｕｄｅ －－＞\n\n公開`;
    expect(() => chunkMarkdown(md, META, { fileName: "10-x.md" })).toThrow(/^10-x\.md:5: .*不是合格的標記/);
  });

  it("合格標記的理由裡有全形標點（括號、冒號、頓號）照常認得，不會被正規化誤判", () => {
    const md = `## A\n\n前文。\n\n<!-- ai:exclude 老師現在的住處（段末：和妹妹同住）、搬家 -->\n\n秘密。\n\n${CLOSE}\n\n後文。`;
    const chunks = chunkMarkdown(md, META, { fileName: "10-x.md" });
    expect(chunks.map((c) => c.content)).toEqual(["前文。\n\n後文。"]);
    expect(stripExcluded(md, "10-x.md").excluded[0].reason).toBe("老師現在的住處（段末：和妹妹同住）、搬家");
  });

  it("語料裡不可以有其他 HTML 註解（它們會被當成內文進塊，也可能是寫錯的標記）", () => {
    expect(() => chunkMarkdown("## A\n\n<!-- 一般註解 -->\n\n甲", META, { fileName: "10-x.md" })).toThrow(/^10-x\.md:3: /);
  });

  it("標記不可以寫在 front-matter 裡，也不可以寫在 front-matter 之前", () => {
    const inside = `---\nsource: 測試\n${OPEN}\ntitle: x\n${CLOSE}\n---\n## A\n\n甲`;
    expect(() => chunkMarkdown(inside, META, { fileName: "10-x.md" })).toThrow(/^10-x\.md:3: .*front-matter 裡/);
    const before = `${OPEN}\n秘密\n${CLOSE}\n---\nsource: 測試\n---\n## A\n\n甲`;
    expect(() => chunkMarkdown(before, META, { fileName: "10-x.md" })).toThrow(/^10-x\.md:1: .*front-matter 之前/);
  });
});

/**
 * 🔴 哨兵：真實語料與索引裡，排除區的句子一句都不可以出現。
 *
 * 防的是「標記整批不見了」這種不會報錯的退化：scripts/import-autobiography.ts 重跑會刪掉並重寫全部自傳檔，
 * 標記跟著消失；重建索引之後 lib/knowledge-index.test.ts 的雜湊又會一致，沒有任何測試會紅。
 * 這裡挑的每一句都只出現在排除區裡（2026-09-28 標記時確認過），出現在切塊結果或索引裡就代表排除失效。
 */
describe("哨兵：排除區的句子不可以進切塊結果與索引", () => {
  const SENTINELS = [
    "摔傷了左下背", // 07 航向另一個港：2021 年摔傷
    "我竟已步上記憶退化的命運了", // 07：記憶退化
    "元晶將我和我的家搬到深坑", // 07：搬到深坑、同住
    "只不過那是個沒有港口也看不到海洋的港—南港", // 07 港城那段：現在和元晶住在南港
    "我在花蓮跌倒需人照顧", // 08：跌倒後的照顧安排
    "元晶獨力幫我搬到臺北和她同住並照顧我", // 08：同住與照顧
    "她加入了教會", // 09：女兒的信仰
    "有每月固定來自二叔的匯款和房租收入", // 09：女兒的經濟
    "長照機構在幫我申請緊急救援服務", // 09：長照安排
    "元晶也定期帶我坐輪椅去醫院看她", // 09：女兒住院、輪椅
    "她於 2023 年年底主動打電話給我們", // 09 母女重逢：2023 年底重新聯絡
    "我請元晶邀了女兒來家裡一起吃年夜飯", // 09 母女重逢：2024 年的年夜飯
    "她也抱怨她的癲癎來自於母親的遺傳", // 09：女兒的健康
    "元晶一接獲消息，立馬拋下一切", // 10：跌倒後元晶照顧
    "看著姊姊拿著拐杖慢慢走路", // 10 元晶專文：拐杖
    "我發現她消瘦了很多", // 04 黃瓊華專文：2022 年的健康
    "元貞的妹妹元晶今天為什麼願意照顧元貞", // 05 劉毓秀專文：現在誰照顧她
    // ⚠️ 年表 2021、2022 兩條原本也在這張表上。2026-09-30 擁有者指示附錄照書收錄，已移到下面「附錄照書收錄」反過來守。
  ];
  const dir = join(process.cwd(), "content", "knowledge");

  it("每一句都還在書裡（被標記、不是被刪掉），而且切塊結果裡一句都沒有", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    const raw = files.map((f) => readFileSync(join(dir, f), "utf-8")).join("\n");
    const chunks = files
      .flatMap((f) => chunkMarkdown(readFileSync(join(dir, f), "utf-8"), { source: f, sourceUrl: "", docTitle: f }, { fileName: f }))
      .map((c) => c.embedInput)
      .join("\n");
    for (let i = 0; i < SENTINELS.length; i++) {
      expect(raw, `書裡找不到「${SENTINELS[i]}」——原文被改了？`).toContain(SENTINELS[i]);
      expect(chunks, `「${SENTINELS[i]}」進了切塊結果——ai:exclude 標記不見了？`).not.toContain(SENTINELS[i]);
    }
  });

  it("索引（data/knowledge-index.json）裡也一句都沒有", () => {
    const index = JSON.parse(readFileSync(join(process.cwd(), "data", "knowledge-index.json"), "utf-8")) as {
      entries: { content: string }[];
    };
    const all = index.entries.map((e) => e.content).join("\n");
    for (let i = 0; i < SENTINELS.length; i++) {
      expect(all, `索引裡有「${SENTINELS[i]}」——用沒有標記的語料重建過索引？`).not.toContain(SENTINELS[i]);
    }
  });

  /**
   * 改寫過的常見問題不受上面的哨兵保護：它們不是書的原文，排除區的事被改寫進去，用原句比對是抓不到的。
   * 2026-09-28 獨立審查抓到 01-biography 母女那一節，把第 9 章「母女重逢」排除區裡 2023 年底重新聯絡、
   * 2024 年一起吃年夜飯的細節重新寫回語料，跟 prompt 規則 5（家人的近況一律說是家人的隱私）衝突。
   * 那一節現在只講書裡未排除的經過，最後明說女兒近年的生活不談；這裡守住它，切塊結果與索引都查。
   */
  const DAUGHTER_FAQ = "母女有重逢嗎";
  const DAUGHTER_FAQ_BANNED = ["2023", "2024", "年夜飯", "重新聯絡", "重新連絡", "南港"];

  it("01-biography 母女那一節：不寫 2023、2024 年的重逢細節，最後明說女兒近年的生活不談", () => {
    const raw = readFileSync(join(dir, "01-biography.md"), "utf-8");
    const text = chunkMarkdown(raw, { source: "x", sourceUrl: "", docTitle: "x" }, { fileName: "01-biography.md" })
      .filter((c) => c.title.includes(DAUGHTER_FAQ))
      .map((c) => c.content)
      .join("\n");
    expect(text, "母女那一節不見了——它是「妳跟女兒後來有聯絡嗎」的檢索入口").not.toBe("");
    for (const banned of DAUGHTER_FAQ_BANNED) {
      expect(text, `母女那一節出現「${banned}」`).not.toContain(banned);
    }
    expect(text).toContain("女兒近年的生活，是女兒自己的私人生活，這裡不談");
  });

  /**
   * 🔴 2026-09-30 擁有者指示：書末附錄一（李元貞年表）、附錄二（臺灣婦女權益進展大事紀）照書收錄，有人問就照實回答。
   * 年表 2021、2022 兩條原本用 ai:exclude 排除（老師近年的健康照顧與住處），這次拿掉標記。
   * 這裡守反方向的退化：之後有人照舊例把這兩條（或整份附錄）再標回排除。附錄以外的近況段落照舊排除，上面的哨兵不變。
   */
  const APPENDIX_FILES = ["10-autobiography-12.md", "10-autobiography-13.md"];
  const APPENDIX_MUST_KEEP = [
    "10 月因身體狀況需要照顧，搬回新北深坑", // 12 年表 2021
    "6 月搬至臺北南港", // 12 年表 2022
  ];

  it("附錄照書收錄：年表與大事紀沒有排除區，2021、2022 兩條進了切塊結果", () => {
    for (const f of APPENDIX_FILES) {
      expect(stripExcluded(readFileSync(join(dir, f), "utf-8"), f).excluded, `${f} 又有 ai:exclude 排除區`).toEqual([]);
    }
    const chunks = APPENDIX_FILES.flatMap((f) =>
      chunkMarkdown(readFileSync(join(dir, f), "utf-8"), { source: f, sourceUrl: "", docTitle: f }, { fileName: f })
    )
      .map((c) => c.content)
      .join("\n");
    for (const s of APPENDIX_MUST_KEEP) expect(chunks, `年表「${s}」不在切塊結果裡`).toContain(s);
  });

  it("附錄照書收錄：索引裡也有 2021、2022 兩條", () => {
    const index = JSON.parse(readFileSync(join(process.cwd(), "data", "knowledge-index.json"), "utf-8")) as {
      entries: { content: string }[];
    };
    const all = index.entries.map((e) => e.content).join("\n");
    for (const s of APPENDIX_MUST_KEEP) expect(all, `索引裡沒有「${s}」——用舊語料建的索引？`).toContain(s);
  });

  it("索引裡的 01-biography 母女那一節也沒有 2023、2024 年的重逢細節", () => {
    const index = JSON.parse(readFileSync(join(process.cwd(), "data", "knowledge-index.json"), "utf-8")) as {
      entries: { title: string; content: string }[];
    };
    const text = index.entries
      .filter((e) => e.title.includes(DAUGHTER_FAQ))
      .map((e) => e.content)
      .join("\n");
    expect(text, "索引裡找不到母女那一節").not.toBe("");
    for (const banned of DAUGHTER_FAQ_BANNED) {
      expect(text, `索引的母女那一節有「${banned}」——用舊的 01-biography 建的索引？`).not.toContain(banned);
    }
  });
});
