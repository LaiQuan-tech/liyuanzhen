"use client";

import { useFormState, useFormStatus } from "react-dom";
import Link from "next/link";
import { saveEventAction, deleteEventAction, type ActionState } from "@/app/admin/actions";
import { EVENT_STATUSES, STATUS_LABEL, type EventRecord } from "@/lib/events";

/**
 * 新增／編輯場次共用的表單。
 *
 * ⚠️ 用原生 form ＋ server action，不接 react-hook-form。
 * 這張表單只有 11 個欄位、沒有動態列、沒有跨欄位連動，引一整套表單函式庫
 * 只是多一層要維護的東西。驗證在 `lib/events/types.ts` 的純函式裡，測得到。
 */

const FIELD =
  "w-full rounded-lg border-[1.5px] border-ink/25 bg-paper-alt px-3 py-2 text-[15px] outline-none focus:border-ink";

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13.5px] font-bold">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12.5px] text-muted">{hint}</span>}
    </label>
  );
}

function SubmitButton() {
  // ⚠️ useFormStatus 必須在 <form> 的子元件裡才讀得到狀態，
  // 寫在同一層會永遠是 false，按鈕就不會有送出中的樣子。
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-full bg-ink px-6 py-3 font-display text-[15px] font-bold text-white disabled:opacity-50"
    >
      {pending ? "儲存中…" : "儲存"}
    </button>
  );
}

export default function EventForm({ event }: { event?: EventRecord }) {
  const [state, formAction] = useFormState<ActionState, FormData>(saveEventAction, {
    errors: [],
  });

  // 驗證失敗時用送出的值回填，不要讓使用者重打一次
  const v = state.values;
  const val = (key: keyof NonNullable<typeof v>, fallback: string | null | undefined) =>
    v ? v[key] : (fallback ?? "");

  return (
    <>
      <form action={formAction} className="mt-6 max-w-2xl space-y-5">
        {event && <input type="hidden" name="id" value={event.id} />}

        {state.errors.length > 0 && (
          <div role="alert" className="rounded-lg bg-wine-wash p-4">
            <p className="text-[13.5px] font-bold text-wine">這些地方要修一下：</p>
            <ul className="mt-1.5 list-disc pl-5 text-[13.5px] text-ink-soft">
              {state.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        <Row label="活動名稱">
          <input name="title" className={FIELD} defaultValue={val("title", event?.title)} />
        </Row>

        <Row
          label="網址代稱"
          hint="會出現在網址裡：/events/這一段。只能用小寫英文、數字與連字號，例如 book-launch-2026。上線後最好不要再改，改了舊連結就失效。"
        >
          <input name="slug" className={FIELD} defaultValue={val("slug", event?.slug)} />
        </Row>

        <Row label="副標">
          <input name="subtitle" className={FIELD} defaultValue={val("subtitle", event?.subtitle)} />
        </Row>

        <Row label="活動介紹" hint="換行會保留。">
          <textarea
            name="description"
            rows={8}
            className={FIELD}
            defaultValue={val("description", event?.description)}
          />
        </Row>

        <div className="grid gap-4 sm:grid-cols-3">
          <Row label="日期">
            <input
              type="date"
              name="event_date"
              className={FIELD}
              defaultValue={val("event_date", event?.event_date)}
            />
          </Row>
          <Row label="開始時間">
            <input
              type="time"
              name="start_time"
              className={FIELD}
              defaultValue={val("start_time", event?.start_time?.slice(0, 5))}
            />
          </Row>
          <Row label="結束時間">
            <input
              type="time"
              name="end_time"
              className={FIELD}
              defaultValue={val("end_time", event?.end_time?.slice(0, 5))}
            />
          </Row>
        </div>

        <Row label="地點名稱">
          <input name="venue" className={FIELD} defaultValue={val("venue", event?.venue)} />
        </Row>

        <Row label="地址">
          <input name="address" className={FIELD} defaultValue={val("address", event?.address)} />
        </Row>

        <Row label="報名說明" hint="例如「免費入場，額滿為止」。會顯示在報名表單上方。">
          <textarea
            name="registration_note"
            rows={3}
            className={FIELD}
            defaultValue={val("registration_note", event?.registration_note)}
          />
        </Row>

        <Row
          label="狀態"
          hint="草稿只有後台看得到。要讓訪客看到並開放報名，選「已發布」。"
        >
          <select
            name="status"
            className={FIELD}
            defaultValue={val("status", event?.status) || "draft"}
          >
            {EVENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </Row>

        <div className="flex items-center gap-4 pt-2">
          <SubmitButton />
          <Link href="/admin" className="text-[14px] text-muted underline underline-offset-4">
            取消
          </Link>
        </div>
      </form>

      {event && (
        <form
          action={deleteEventAction}
          className="mt-12 max-w-2xl border-t border-ink/10 pt-6"
          onSubmit={(e) => {
            // 🔴 二次確認要把後果講出來。報名紀錄會跟著 cascade 刪掉，
            // 那些是真人的姓名與電話，刪掉就沒了。
            if (
              !confirm(
                `確定要刪除「${event.title}」嗎？\n\n這一場的所有報名紀錄（姓名、信箱、電話）會一起被刪除，而且救不回來。\n\n只是想讓它從公開頁消失的話，把狀態改成「草稿」就好。`
              )
            ) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="id" value={event.id} />
          <input type="hidden" name="slug" value={event.slug} />
          <p className="text-[13px] text-muted">
            刪除會連同這一場的報名紀錄一起刪掉。想下架就改狀態，不要刪。
          </p>
          <button
            type="submit"
            className="mt-3 rounded-lg border-[1.5px] border-wine px-4 py-2 text-[13.5px] font-bold text-wine hover:bg-wine-wash"
          >
            刪除這一場
          </button>
        </form>
      )}
    </>
  );
}
