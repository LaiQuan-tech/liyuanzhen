"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin-auth";
import {
  createEvent,
  updateEvent,
  deleteEvent,
  validateEvent,
  type EventInput,
} from "@/lib/events";

/**
 * 後台的寫入動作。
 *
 * 🔴 **每一支的第一行都是 `await requireAdmin()`。** 沒有例外。
 *
 * server action 是一個可以被直接呼叫的端點——瀏覽器 devtools 裡就打得到，
 * middleware 擋不住。少寫一支，那一支就是整個後台的洞。
 * 新增 action 的時候先寫這一行，再寫其他的。
 *
 * ⚠️ 這些函式沒辦法用 curl 測（server action 的呼叫協定含有 Next 產生的 id），
 * 要驗權限就在瀏覽器裡用一個沒有 admin 角色的帳號登入後實際操作。
 */

/** 表單欄位 → EventInput。缺的欄位一律當空字串，不要讓 undefined 流進驗證。 */
function readForm(form: FormData): EventInput {
  const get = (k: string) => String(form.get(k) ?? "").trim();
  return {
    title: get("title"),
    slug: get("slug"),
    subtitle: get("subtitle"),
    description: String(form.get("description") ?? ""),
    event_date: get("event_date"),
    start_time: get("start_time"),
    end_time: get("end_time"),
    venue: get("venue"),
    address: get("address"),
    registration_note: String(form.get("registration_note") ?? ""),
    status: get("status"),
  };
}

export interface ActionState {
  errors: string[];
  /** 表單送出的內容。驗證失敗時要回填，不要讓使用者重打一次。 */
  values?: EventInput;
}

export async function saveEventAction(
  _prev: ActionState,
  form: FormData
): Promise<ActionState> {
  await requireAdmin();

  const id = String(form.get("id") ?? "").trim();
  const input = readForm(form);

  const check = validateEvent(input);
  if (!check.ok) return { errors: check.errors, values: input };

  try {
    if (id) {
      await updateEvent(id, input);
    } else {
      await createEvent(input);
    }
  } catch (error) {
    return {
      errors: [error instanceof Error ? error.message : "儲存失敗"],
      values: input,
    };
  }

  // 後台列表與公開頁都要更新。⚠️ 公開頁那兩條不可以漏——
  // 「上架了但公開頁沒變」是這個後台最容易被抱怨的失敗方式。
  revalidatePath("/admin");
  revalidatePath("/events");
  revalidatePath(`/events/${input.slug}`);

  // redirect 會丟一個特殊例外，所以要放在 try 外面，不然會被上面的 catch 吃掉
  redirect("/admin");
}

export async function deleteEventAction(form: FormData): Promise<void> {
  await requireAdmin();
  const id = String(form.get("id") ?? "").trim();
  const slug = String(form.get("slug") ?? "").trim();
  if (!id) return;

  await deleteEvent(id);

  revalidatePath("/admin");
  revalidatePath("/events");
  if (slug) revalidatePath(`/events/${slug}`);
  redirect("/admin");
}
