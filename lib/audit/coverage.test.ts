import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * 防呆：每一支後台的 server action 都要「先擋權限、再記日誌」。
 *
 * ── 為什麼需要這條測試 ──────────────────────────────────────
 *
 * 0006 刻意**不**給 authenticated 寫入 `user_roles` 的權限，所以少了
 * 「server action 忘記 requireManager() 時由 DB policy 兜底」那一層
 *（理由見 0006 第二節：這個站的 anon client ＋ 管理員 session 活在瀏覽器裡，
 * 一旦開放寫入，任何管理員在 devtools 打一行 insert 就能自己升權，
 * 而且不會留下稽核紀錄）。那一層的替代品就是這個檔。
 *
 * 同理，稽核日誌是**應用層**寫的而不是 DB trigger（0006 第四節），
 * 所以「漏寫一支 writeAudit」沒有任何機制會發現——那種操作從此不留紀錄，
 * 而且畫面上一切正常。
 *
 * ── 它擋得住什麼 ──────────────────────────────────────────
 *
 *   ✅ 新增一支 action，忘了 requireStaff()／requireManager()
 *   ✅ 新增一支 action，忘了 writeAudit()
 *   ✅ 把既有 action 的那兩行刪掉
 *
 * ── 它**擋不住**什麼（不要以為跑綠了就安全）──────────────────
 *
 *   ❌ entity／action／label 填錯（它只看有沒有呼叫，不看參數）
 *   ❌ 在既有 action 裡**多加一次**沒有記錄的寫入——一支函式記了一筆，
 *      不代表它做的三件事都被記下來
 *   ❌ 繞過 server action 的寫入（直接改 Dashboard、或未來新增的 route handler）
 *   ❌ 把 requireManager() 誤寫成 requireStaff()（權限降級，這裡看起來一樣過）
 *
 * ── 這個檢查自己也被測 ──────────────────────────────────────
 *
 * 下面 describe("檢查函式自己") 餵了一段一定會過與三段一定不會過的字串。
 * 沒有那幾條的話，`checkActionCoverage` 寫壞成「永遠回空陣列」時，
 * 上面那幾條會安靜地全綠——一個永遠不會紅的測試比沒有測試更危險。
 */

/** 被掃描的檔案。新增放 server action 的檔案時要加進來。 */
const SOURCES = [
  "app/admin/actions.ts",
  "app/admin/(dashboard)/admins/actions.ts",
  // ⚠️ 這一支只有 signOutAction，而它在豁免清單裡。
  // 納入掃描是為了讓豁免清單是活的：哪天有人往這個檔加第二支 action，
  // 這條測試會紅。
  "app/admin/auth-actions.ts",
];

/**
 * 明寫的例外。
 *
 * 🔴 `signOutAction` 是這個 codebase 既有的、**刻意不套規矩**的先例：
 * 登出是唯一不該有權限要求的動作——一個沒有後台權限的帳號登入之後，
 * 最需要做的事就是登出。它也不需要稽核（誰登出了不是安全事件，
 * 而且把它記進去只會把日誌淹掉）。
 *
 * ⚠️ 往這裡加名字之前先想清楚：豁免一支 action ＝ 那支的操作永遠不會
 * 留下紀錄。理由要寫在這個註解裡，不要只加一個字串。
 */
const AUDIT_EXEMPT: readonly string[] = ["signOutAction"];

export interface ActionProblem {
  name: string;
  missing: string[];
}

/**
 * 把註解換成等長的空白（換行保留）。
 *
 * 🔴 這一步不可省，而且第一版就是漏了它。
 * 少了它的話，把 `await writeAudit(...)` **註解掉**仍然會讓檢查通過——
 * 因為那段文字還在檔案裡。而「先註解起來之後再說」正是這種疏漏最常見的
 * 發生方式，比整段刪掉常見得多。
 *
 * ⚠️ 輸出刻意與輸入**等長**：函式體是用「下一個第 0 欄的 `}`」切出來的，
 * 把註解整段刪掉會讓行列位置跑掉。
 *
 * ⚠️ 這是一個小型掃描器，不是 parser。它認得三種字串（' " `）與兩種註解，
 * **不認得**：正規表達式字面值裡的 `//`、樣板字面值 `${}` 內部再出現的引號。
 * 這兩種東西目前不存在於被掃描的檔案裡；哪天出現了，症狀會是「誤判成缺少」
 *（測試變紅）而不是「誤判成通過」——那個方向的錯誤是安全的。
 */
export function stripComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  let quote: string | null = null;

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (quote) {
      out.push(c);
      if (c === "\\") {
        // 跳脫字元：連同下一個字一起原樣抄過去
        if (i + 1 < source.length) out.push(next);
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out.push(c);
      i += 1;
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }

    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (; i < stop; i += 1) out.push(source[i] === "\n" ? "\n" : " ");
      continue;
    }

    out.push(c);
    i += 1;
  }

  return out.join("");
}

/**
 * 把一支頂層函式的原始碼切出來。
 *
 * ⚠️ 用「下一個頂層 `}`（第 0 欄）」當結尾，而不是配對大括號。
 * 配對大括號要先處理字串、樣板字面值與註解裡的大括號，那是一個小型 parser；
 * 這個專案的排版固定由 prettier 產生（頂層函式的右大括號一定在第 0 欄），
 * 所以這個作法夠用而且不會誤判。
 * **代價**：哪天有人手動把右大括號縮排，這裡切出來的範圍會太長——
 * 那個方向的錯誤是「誤判成通過」，所以下面才要另外斷言「有掃到幾支」。
 */
function functionBody(source: string, startIndex: number): string {
  const end = source.indexOf("\n}", startIndex);
  return end === -1 ? source.slice(startIndex) : source.slice(startIndex, end + 2);
}

/**
 * 檔案裡每一支 `export async function *Action` 的名字與函式體。
 *
 * ⚠️ 函式體是**去掉註解之後**的版本——被註解掉的呼叫不算數。
 */
export function extractActions(source: string): { name: string; body: string }[] {
  const code = stripComments(source);
  const out: { name: string; body: string }[] = [];
  const re = /^export async function (\w*Action)\b/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    out.push({ name: match[1], body: functionBody(code, match.index) });
  }
  return out;
}

/**
 * 找出「沒有擋權限」或「沒有記日誌」的 action。
 *
 * 回傳空陣列＝全部合格。
 */
export function checkActionCoverage(
  source: string,
  exempt: readonly string[] = AUDIT_EXEMPT
): ActionProblem[] {
  const problems: ActionProblem[] = [];
  for (const { name, body } of extractActions(source)) {
    if (exempt.includes(name)) continue;
    const missing: string[] = [];
    if (!/require(Staff|Manager)\s*\(/.test(body)) missing.push("requireStaff|requireManager");
    if (!/writeAudit\s*\(/.test(body)) missing.push("writeAudit");
    if (missing.length) problems.push({ name, missing });
  }
  return problems;
}

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8");
}

describe("後台 server action 的權限與稽核覆蓋", () => {
  for (const relative of SOURCES) {
    it(`${relative} 的每一支 action 都有擋權限也有記日誌`, () => {
      const problems = checkActionCoverage(read(relative));
      expect(
        problems,
        problems.map((p) => `${p.name} 缺少 ${p.missing.join(" 與 ")}`).join("；")
      ).toEqual([]);
    });
  }

  /**
   * 🔴 沒有這一條，上面那幾條就可能是空跑的。
   *
   * 正規表達式寫壞、檔案被搬走、prettier 換了排版——任何一種都會讓
   * extractActions 回空陣列，而「空陣列沒有問題」會讓測試全綠。
   */
  it("真的有掃到 action（不是空跑）", () => {
    const names = SOURCES.flatMap((s) => extractActions(read(s)).map((a) => a.name));
    expect(names).toContain("saveEventAction");
    expect(names).toContain("deleteEventAction");
    expect(names).toContain("createAdminAction");
    expect(names).toContain("setRoleAction");
    expect(names).toContain("resetPasswordAction");
    expect(names).toContain("revokeRoleAction");
    expect(names).toContain("deleteAccountAction");
    expect(names).toContain("signOutAction");
    expect(names.length).toBeGreaterThanOrEqual(8);
  });

  /** 豁免清單不能爛掉：裡面的名字要真的存在，否則它只是一段沒人維護的字串。 */
  it("豁免清單裡的名字都真的存在", () => {
    const names = SOURCES.flatMap((s) => extractActions(read(s)).map((a) => a.name));
    for (const name of AUDIT_EXEMPT) {
      expect(names, `${name} 在豁免清單裡但找不到這支 action`).toContain(name);
    }
  });
});

describe("檢查函式自己", () => {
  const GOOD = `"use server";

export async function okAction(form: FormData): Promise<void> {
  const actor = await requireManager();
  await doSomething(form);
  await writeAudit(actor, { action: "update", entity: "admin" });
}
`;

  const NO_AUDIT = `"use server";

export async function sloppyAction(form: FormData): Promise<void> {
  const actor = await requireManager();
  await doSomething(form);
}
`;

  const NO_GUARD = `"use server";

export async function wideOpenAction(form: FormData): Promise<void> {
  await doSomething(form);
  await writeAudit(actor, { action: "update", entity: "admin" });
}
`;

  const NEITHER = `"use server";

export async function nakedAction(form: FormData): Promise<void> {
  await doSomething(form);
}
`;

  it("合格的那段真的過", () => {
    expect(checkActionCoverage(GOOD, [])).toEqual([]);
  });

  it("漏記日誌的那段真的紅", () => {
    expect(checkActionCoverage(NO_AUDIT, [])).toEqual([
      { name: "sloppyAction", missing: ["writeAudit"] },
    ]);
  });

  it("漏擋權限的那段真的紅", () => {
    expect(checkActionCoverage(NO_GUARD, [])).toEqual([
      { name: "wideOpenAction", missing: ["requireStaff|requireManager"] },
    ]);
  });

  it("兩樣都漏的一次講兩個問題", () => {
    expect(checkActionCoverage(NEITHER, [])).toEqual([
      { name: "nakedAction", missing: ["requireStaff|requireManager", "writeAudit"] },
    ]);
  });

  it("豁免清單真的會讓那一支被跳過", () => {
    expect(checkActionCoverage(NEITHER, ["nakedAction"])).toEqual([]);
  });

  // 切函式體的方式要真的切得開，不然第二支的內容會被算進第一支
  it("兩支相鄰的 action 不會互相借用對方的內容", () => {
    const source = `${GOOD}\n${NO_AUDIT}`;
    expect(checkActionCoverage(source, [])).toEqual([
      { name: "sloppyAction", missing: ["writeAudit"] },
    ]);
  });

  it("不是 action 的匯出函式不管", () => {
    const source = `export async function listThings(): Promise<void> {\n  return;\n}\n`;
    expect(checkActionCoverage(source, [])).toEqual([]);
  });

  /**
   * 🔴 這一條是第一版漏掉的洞。
   *
   * 「先把它註解起來之後再說」比整段刪掉常見得多，而且看起來人畜無害。
   * 沒有 stripComments 的話，下面這段會通過檢查——日誌從此少一種動作，
   * 而測試是綠的。
   */
  it("被註解掉的 writeAudit 不算數", () => {
    const commented = `"use server";

export async function sneakyAction(form: FormData): Promise<void> {
  const actor = await requireManager();
  await doSomething(form);
  // await writeAudit(actor, { action: "revoke", entity: "admin" });
}
`;
    expect(checkActionCoverage(commented, [])).toEqual([
      { name: "sneakyAction", missing: ["writeAudit"] },
    ]);
  });

  it("被區塊註解包起來的也不算數", () => {
    const commented = `"use server";

export async function blockAction(form: FormData): Promise<void> {
  const actor = await requireManager();
  /* 暫時關掉
  await writeAudit(actor, { action: "revoke", entity: "admin" });
  */
}
`;
    expect(checkActionCoverage(commented, [])).toEqual([
      { name: "blockAction", missing: ["writeAudit"] },
    ]);
  });

  // 字串裡的 // 不是註解——把它當註解會從那裡開始吃掉整行真正的程式碼
  it("字串裡的雙斜線不會被當成註解", () => {
    const source = `"use server";

export async function urlAction(form: FormData): Promise<void> {
  const actor = await requireManager();
  const where = "https://example.com"; await writeAudit(actor, { action: "update", entity: "event", label: where });
}
`;
    expect(checkActionCoverage(source, [])).toEqual([]);
  });

  it("stripComments 不改變字元總數（行列位置要對得上）", () => {
    const source = `const a = 1; // 註解\n/* 兩行\n   註解 */\nconst b = "// 不是註解";\n`;
    expect(stripComments(source)).toHaveLength(source.length);
    expect(stripComments(source)).toContain('"// 不是註解"');
    expect(stripComments(source)).not.toContain("兩行");
  });
});
