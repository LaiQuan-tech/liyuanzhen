import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import ChatPanel from "@/components/chat/ChatPanel";

export const metadata: Metadata = { title: "與數位李元貞對話｜李元貞 × AI 數位人" };

export default function ChatPage({
  searchParams,
}: {
  searchParams?: { q?: string };
}) {
  const initialQuestion = typeof searchParams?.q === "string" ? searchParams.q : undefined;

  return (
    <>
      <Nav />
      <main className="lz-wrap py-10 md:py-14">
        <div className="mb-7">
          <span className="lz-eyebrow">與數位人對話</span>
          <h1 className="lz-h2 mt-4">上網，就能親口問她。</h1>
          <p className="lz-lead mt-3 text-[17px]">
            問婦女運動的歷史，問李元貞老師的生平與著作。回答依公開資料生成，
            資料裡沒有的，她會直接說不知道。
          </p>
        </div>

        <ChatPanel initialQuestion={initialQuestion} />
      </main>
      <Footer />
    </>
  );
}
