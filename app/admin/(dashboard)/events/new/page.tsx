import EventForm from "@/components/admin/EventForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "新增場次｜活動後台" };

export default function NewEventPage() {
  return (
    <>
      <h1 className="font-display text-[20px] font-extrabold">新增場次</h1>
      <p className="mt-2 text-[13.5px] text-muted">
        新建的場次預設是草稿，公開頁看不到。內容都填好之後再把狀態改成「已發布」。
      </p>
      <EventForm />
    </>
  );
}
