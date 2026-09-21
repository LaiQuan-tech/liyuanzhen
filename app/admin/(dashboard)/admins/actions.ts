"use server";

import { revalidatePath } from "next/cache";
import { requireManager } from "@/lib/admin-auth";
import { writeAudit } from "@/lib/audit";
import {
  listAdmins,
  countManagers,
  grantRole,
  revokeRole,
  parseRole,
  passwordProblems,
  validateNewAdmin,
  ROLE_LABEL,
  type AdminActionState,
  type AdminRow,
} from "@/lib/admins";
import {
  createAuthUser,
  setUserPassword,
  deleteAuthUser,
} from "@/lib/admins/provision";

/**
 * 後台人員管理的寫入動作。
 *
 * 🔴 **每一支的第一行都是 `const actor = await requireManager()`。** 沒有例外。
 * server action 是一個可以被直接呼叫的端點——瀏覽器 devtools 裡就打得到，
 * middleware 與側邊欄的顯示過濾都擋不住。少寫一支，那一支就是整個後台的洞。
 *
 * 🔴 **每一支都要 `await writeAudit(actor, …)`。**
 * 這個站的稽核是應用層寫的（理由見 0006 第四節），漏一支就等於那種操作
 * 從來不會留下紀錄，而且不會有任何徵兆。`lib/audit/coverage.test.ts` 會掃這個檔。
 *
 * ⚠️ 這個檔是 `"use server"`，**只能 export async function**。
 * 常數（ROLE_LABEL、IDLE_STATE 之類）放在 `lib/admins/types.ts`。
 * 那個錯誤只有 `npm run build` 會現形，`tsc --noEmit` 不會擋。
 *
 * ⚠️ 這些函式沒辦法用 curl 測（server action 的呼叫協定含有 Next 產生的 id），
 * 要驗權限就在瀏覽器裡用一個小編帳號登入後實際操作。
 */

const LIST_PATH = "/admin/admins";

/** 表單上的 user_id。空字串一律當沒填。 */
function readUserId(form: FormData): string {
  return String(form.get("user_id") ?? "").trim();
}

/** 這一列現在的樣子。拿來當日誌的 label，也拿來判斷他是不是管理員。 */
async function findRow(userId: string): Promise<AdminRow | undefined> {
  const rows = await listAdmins();
  return rows.find((r) => r.user_id === userId);
}

/**
 * 新增後台人員。
 *
 * 🔴 兩個步驟，而且第二步失敗要回滾：
 *   1. `createAuthUser`（GoTrue，service_role）
 *   2. `grantRole`（user_roles，service_role）
 *   3. 第 2 步失敗**且這次真的建了帳號**才 `deleteAuthUser` 回滾
 *
 * ⚠️ email 已經存在時**接手既有帳號但絕不改密碼**——那可能是別人正在用的
 * 帳號。所以那條路的成功訊息要明講「密碼維持原本那組」，否則操作者會把
 * 自己剛剛打的那組唸給對方，而對方登不進來。
 * 同理，那條路上授權失敗時**不可以**刪帳號——那個帳號不是這次建的。
 */
export async function createAdminAction(
  _prev: AdminActionState,
  form: FormData
): Promise<AdminActionState> {
  const actor = await requireManager();

  const email = String(form.get("email") ?? "").trim().toLowerCase();
  // 🔴 密碼不 trim。前後空白是密碼的一部分（見 lib/admins/types.ts）。
  const password = String(form.get("password") ?? "");
  const roleRaw = String(form.get("role") ?? "");

  const check = validateNewAdmin({ email, password, role: roleRaw });
  if (!check.ok) return { errors: check.errors };

  const role = parseRole(roleRaw);
  if (!role) return { errors: ["請選擇層級"] };

  const created = await createAuthUser(email, password);
  if (!created.ok) return { errors: [created.message] };

  try {
    await grantRole(created.userId, role);
  } catch (error) {
    const message = error instanceof Error ? error.message : "設定層級失敗";

    // 這次沒有建帳號（接手既有帳號）就沒有東西可以回滾——刪掉別人的帳號
    // 才是真正的災難。
    if (created.existed) return { errors: [message] };

    const rollback = await deleteAuthUser(created.userId);
    if (rollback.ok) {
      // 乾淨地回到原狀，什麼都沒發生，所以刻意不寫日誌。
      return { errors: [message] };
    }

    /*
     * 🔴 回滾也失敗：留下一個孤兒帳號。
     *
     * 這種帳號登得進來（email_confirm 是 true），會撞到 layout 的
     * 「沒有權限」畫面——但**人員列表讀的是 user_roles，所以看不到它**。
     * 不留一筆日誌的話，沒有任何人會知道它存在。
     */
    await writeAudit(actor, {
      action: "insert",
      entity: "admin",
      entityId: created.userId,
      label: `${email}（建立失敗且孤兒帳號未清乾淨）`,
    });
    return {
      errors: [
        `${message}`,
        `⚠️ ${email} 的帳號已經建立但沒有拿到權限，而且自動清除也失敗了（${rollback.message}）。` +
          `這個帳號不會出現在下面的列表裡，請到 Supabase Dashboard 的 Authentication 手動刪除。` +
          `操作日誌已經記下這一筆。`,
      ],
    };
  }

  await writeAudit(actor, {
    action: "insert",
    entity: "admin",
    entityId: created.userId,
    label: `${email}（${ROLE_LABEL[role]}）`,
  });

  revalidatePath(LIST_PATH);

  // ⚠️ 成功訊息**不要重複顯示密碼**。那是操作者自己剛打的，再印一次
  // 只是多一個會被截圖或肩窺的地方。
  return {
    errors: [],
    message: created.existed
      ? `${email} 本來就有帳號，已加入後台（${ROLE_LABEL[role]}）。` +
        `⚠️ 密碼維持原本那組，不是你剛剛輸入的那一組——要換請用那一列的「重設密碼」。`
      : `已新增 ${email}（${ROLE_LABEL[role]}）。請把剛剛設定的密碼當面或用電話交給對方。`,
  };
}

/**
 * 改層級。
 *
 * 🔴 **不能改自己的。** 這裡只有管理員進得來，所以「改自己」唯一的意思就是
 * 把自己降成小編——那一秒之後他就管不了人了，而且可能是這個站最後一位管理員。
 * 按鈕不渲染只是體驗，這一行才是實際的守門。
 */
export async function setRoleAction(
  _prev: AdminActionState,
  form: FormData
): Promise<AdminActionState> {
  const actor = await requireManager();

  const userId = readUserId(form);
  if (!userId) return { errors: ["缺少帳號編號"] };
  if (userId === actor.id) {
    return { errors: ["不能改自己的層級。請另一位管理員操作。"] };
  }

  const role = parseRole(String(form.get("role") ?? ""));
  if (!role) return { errors: ["請選擇層級"] };

  const row = await findRow(userId);
  if (!row) return { errors: ["找不到這位人員，可能剛剛被移除了。"] };
  if (row.role === role) {
    return { errors: [], message: `${row.email ?? userId} 已經是${ROLE_LABEL[role]}了。` };
  }

  try {
    await grantRole(userId, role);
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : "設定層級失敗"] };
  }

  await writeAudit(actor, {
    action: "update",
    entity: "admin",
    entityId: userId,
    label: `${row.email ?? userId}：${ROLE_LABEL[row.role]} → ${ROLE_LABEL[role]}`,
  });

  revalidatePath(LIST_PATH);
  return { errors: [], message: `已改成${ROLE_LABEL[role]}` };
}

/**
 * 重設密碼。
 *
 * 🔴 日誌**只記「重設了密碼」，絕對不記密碼本身**。
 * 稽核日誌是 append-only、所有管理員都看得到，而且刪不掉——把明碼密碼
 * 寫進去等於永久公開它。要記的事實是「誰在什麼時候改了誰的密碼」，
 * 不是改成了什麼。
 */
export async function resetPasswordAction(
  _prev: AdminActionState,
  form: FormData
): Promise<AdminActionState> {
  const actor = await requireManager();

  const userId = readUserId(form);
  if (!userId) return { errors: ["缺少帳號編號"] };

  // 🔴 不 trim。
  const password = String(form.get("password") ?? "");
  const problems = passwordProblems(password);
  if (problems.length) return { errors: problems };

  const row = await findRow(userId);
  if (!row) return { errors: ["找不到這位人員，可能剛剛被移除了。"] };

  const result = await setUserPassword(userId, password);
  if (!result.ok) return { errors: [result.message] };

  await writeAudit(actor, {
    action: "password",
    entity: "admin",
    entityId: userId,
    // ⚠️ 只有「誰的」，沒有密碼。
    label: row.email ?? userId,
  });

  revalidatePath(LIST_PATH);
  return {
    errors: [],
    message: `已重設 ${row.email ?? userId} 的密碼。對方原本那組立刻失效，請通知他。`,
  };
}

/**
 * 移除後台權限（帳號留著，可逆）。
 *
 * 🔴 **不能對自己做。** 按鈕不渲染只是體驗，這一行才是實際的守門。
 */
export async function revokeRoleAction(
  _prev: AdminActionState,
  form: FormData
): Promise<AdminActionState> {
  const actor = await requireManager();

  const userId = readUserId(form);
  if (!userId) return { errors: ["缺少帳號編號"] };
  if (userId === actor.id) {
    return { errors: ["不能移除自己的權限。請另一位管理員操作。"] };
  }

  const row = await findRow(userId);
  if (!row) return { errors: ["找不到這位人員，可能剛剛被移除了。"] };

  // 自己先數一次，訊息才講得出「因為他是最後一位管理員」。
  // ⚠️ 這不是保證——真正擋住的是 0006 的 trigger（它會鎖表再數，擋得住
  // 兩個人同時互相移除）。兩層都要有：這一層給好訊息，那一層給正確性。
  if (row.role === "admin" && (await countManagers()) <= 1) {
    return { errors: ["這是最後一位管理員，移除之後就沒有人能管理後台了。"] };
  }

  try {
    await revokeRole(userId);
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : "移除權限失敗"] };
  }

  await writeAudit(actor, {
    action: "revoke",
    entity: "admin",
    entityId: userId,
    label: `${row.email ?? userId}（原為${ROLE_LABEL[row.role]}）`,
  });

  revalidatePath(LIST_PATH);
  return { errors: [], message: `已移除 ${row.email ?? userId} 的後台權限，帳號保留。` };
}

/**
 * 刪除帳號（不可逆）。
 *
 * 🔴 **不能對自己做。**
 *
 * ⚠️ 刪 auth 帳號會 cascade 掉 user_roles 那一列，所以不需要（也不該）
 * 另外呼叫 revokeRole。
 *
 * ⚠️ 先自己數一次管理員人數，才講得出「因為他是最後一位」。
 * 保證仍然在 0006 的 trigger——但 GoTrue 會不會把 `LAST_ADMIN` 的原文
 * 透出來並不確定，所以兩層都要有。
 */
export async function deleteAccountAction(
  _prev: AdminActionState,
  form: FormData
): Promise<AdminActionState> {
  const actor = await requireManager();

  const userId = readUserId(form);
  if (!userId) return { errors: ["缺少帳號編號"] };
  if (userId === actor.id) {
    return { errors: ["不能刪除自己的帳號。請另一位管理員操作。"] };
  }

  const row = await findRow(userId);
  if (!row) return { errors: ["找不到這位人員，可能剛剛被移除了。"] };

  if (row.role === "admin" && (await countManagers()) <= 1) {
    return { errors: ["這是最後一位管理員，刪掉就沒有人能管理後台了。"] };
  }

  // email 要在刪除之前抓下來——刪完就查不到了，而日誌要的就是那個快照。
  const label = row.email ?? userId;

  const result = await deleteAuthUser(userId);
  if (!result.ok) return { errors: [result.message] };

  await writeAudit(actor, {
    action: "delete",
    entity: "admin",
    entityId: userId,
    label,
  });

  revalidatePath(LIST_PATH);
  return { errors: [], message: `已刪除 ${label} 的帳號。` };
}
