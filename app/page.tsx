import Link from "next/link";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Reveal from "@/components/Reveal";
import DigitalAvatar from "@/components/avatar/DigitalAvatar";
import { AVATAR_NAME, ANSWER_DISCLAIMER } from "@/content/site";
import { OPENING_QUESTIONS } from "@/content/suggested-questions";
import { TIMELINE, QUOTES, MISATTRIBUTED, WORKS, PORTRAIT } from "@/content/homepage";

/**
 * 首頁。主角是李元貞，主行動是 /live。
 *
 * ⚠️ 配色是五色分區：每個區塊輪一個主色，結構一致、只有顏色在跳。
 * 長文區塊用 wash 淺底 ＋ 飽和色當強調（滿版飽和色配長文很難讀），
 * Hero 與語錄這兩個「短而重」的區塊才吃滿版。對比度見 globals.css 檔頭。
 *
 * ⚠️ 時間軸與語錄都靠 `/chat?q=` 深連結送進對話——ChatPanel 收到 ?q= 會自動送出。
 * 這就是為什麼不需要 /timeline 與 /quotes 兩個路由。加新頁之前先想想這條路夠不夠。
 *
 * ⚠️ 這一頁曾經有兩個 404（hero 的 /timeline、入口卡的 /book /quotes），
 * 而檔頭註解還寫著「已上線的入口才給連結」。加連結前先確認路由真的存在。
 */

/** 區塊標題群。七個 section 都用同一組，避免各寫各的慢慢走鐘。 */
function SectionHead({
  eyebrow,
  title,
  lead,
  tone = "ink",
}: {
  eyebrow: string;
  title: React.ReactNode;
  lead?: React.ReactNode;
  /** light ＝ 深色底上的白字版本 */
  tone?: "ink" | "light";
}) {
  return (
    <Reveal>
      <span className={eyebrow ? (tone === "light" ? "lz-pill" : "lz-eyebrow") : "hidden"}>
        {eyebrow}
      </span>
      <h2 className={`lz-h2 mt-4 ${tone === "light" ? "text-white" : ""}`}>{title}</h2>
      {lead && (
        <p className={`lz-lead mt-4 ${tone === "light" ? "!text-white/85" : ""}`}>{lead}</p>
      )}
    </Reveal>
  );
}

export default function HomePage() {
  return (
    <>
      <Nav />
      <main>
        {/* ── 1. Hero ─────────────────────────────────────────── */}
        {/* 主標是她自己的話：《眾女成城》上冊題「父權牆上打小洞」，
            下冊回應「釘子要釘穿」。不是我們編的標語。 */}
        <section className="lz-section border-b-2 border-ink bg-flame">
          <div className="lz-wrap-wide grid items-center gap-10 md:grid-cols-[1fr_minmax(0,340px)]">
            <Reveal>
              <span className="lz-eyebrow">{AVATAR_NAME}</span>
              {/* ⚠️ 這是她自己的詩，不是我們寫的標語。出處：〈兩女人散步——給芳枝〉，
                  《我來了！臺灣婦女改變了》第 6 章，第 182 頁。
                  原詩在「如果」之後跨行（「…黑夜來臨，如果／戰鬥，擁抱理想…」），
                  這裡按語意重新斷行讓它獨立當標語時讀得順，**一個字都沒有改**。 */}
              <h1 className="lz-h1 mt-5">
                女戰士不怕，不怕黑夜來臨
                <br />
                如果戰鬥，擁抱理想，黑夜即成愛人
              </h1>
              <p className="mt-4 text-[13px] text-ink-soft/70">
                —— 李元貞〈兩女人散步——給芳枝〉，《我來了！臺灣婦女改變了》
              </p>
              <p className="lz-lead mt-5 !text-ink-soft">
                李元貞，台灣婦運先驅。1982 年她辦了《婦女新知》，
                從一本雜誌開始，一條一條把法律改過來。現在，你可以直接問她。
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/live" className="lz-cta">
                  面對面問她 →
                </Link>
                <Link href="/chat" className="lz-cta-ghost">
                  改用文字對話
                </Link>
              </div>
              <p className="mt-4 text-[13px] text-ink-soft/70">
                需要麥克風。不方便出聲，用文字版一樣問。
              </p>
            </Reveal>

            <Reveal delay={0.12}>
              {/* 照片位。PORTRAIT 是 null 時這裡是完整的視覺，不是破圖——
                  換圖只改 content/homepage.ts 的一個常數，不動版面。 */}
              {/* ⚠️ 比例跟著照片走。現用這張是 4:3 橫幅，容器若還是 4:5 直式，
                  object-cover 會把左右裁掉——她的臉偏左，會被切到。
                  換成直式照片時記得把這裡改回 aspect-[4/5]。 */}
              <div className="lz-card aspect-[4/3] overflow-hidden !p-0">
                {PORTRAIT ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={PORTRAIT.src}
                    alt={PORTRAIT.alt}
                    className="h-full w-full object-cover object-top"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-brand">
                    <span className="font-display text-[120px] font-extrabold leading-none">
                      李
                    </span>
                  </div>
                )}
              </div>
              <p className="mt-3 text-[12.5px] text-ink-soft/70">
                李元貞，1946 年生。台大中文系碩士，淡江大學中文系榮譽教授。
              </p>
            </Reveal>
          </div>
        </section>

        {/* ── 2. 兩種問法 ──────────────────────────────────────── */}
        <section className="lz-section bg-paper-alt">
          <div className="lz-wrap">
            <SectionHead
              eyebrow="兩種問法"
              title={
                <>
                  想聽她的聲音，
                  <br />
                  或是安靜地讀。
                </>
              }
              lead="「面對面問她」是全螢幕，按住說話，她用自己的聲音回答。「文字對話」是用打的，適合通勤、圖書館，或不方便出聲的時候。"
            />

            <Reveal delay={0.1}>
              <div className="lz-device mx-auto mt-10 max-w-[560px]">
                <div className="flex items-center gap-2 border-b-2 border-ink bg-paper-tint px-4 py-2.5">
                  <span className="h-3 w-3 rounded-full border-[1.5px] border-ink bg-brand" />
                  {/* ⚠️ 用常數，不要硬編——這裡以前寫死，改 AVATAR_NAME 時首頁不會跟著改 */}
                  <span className="font-mono text-[11.5px] text-muted">{AVATAR_NAME}</span>
                </div>

                <div className="space-y-3 px-5 py-6">
                  <div className="flex justify-center pb-2">
                    <DigitalAvatar state="idle" showLabel={false} />
                  </div>
                  <div className="lz-bubble-me ml-auto max-w-[85%] text-[15px]">
                    婦女新知是怎麼開始的？
                  </div>
                  <div className="lz-bubble-her text-[15px]">
                    1982 年 2 月，《婦女新知》雜誌創刊，這是台灣第一個女性主義雜誌社。
                    當時還在戒嚴，結社不自由，所以是以雜誌之名，行婦運之實。
                  </div>
                  {/* 示範畫面也要附免責句——假的示範配真的揭露，才是這個站該有的樣子。
                      ⚠️ 用 text-muted 不是 text-muted-light：這句是必須存在的免責，
                      不是可有可無的三級文字，不要為了視覺清爽把它調淡。 */}
                  <p className="text-[11.5px] leading-relaxed text-muted">{ANSWER_DISCLAIMER}</p>
                  <div className="flex flex-wrap justify-center gap-2 pt-2">
                    {OPENING_QUESTIONS.map((q) => (
                      <Link key={q} href={`/chat?q=${encodeURIComponent(q)}`} className="lz-chip">
                        {q}
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
              <p className="mt-4 text-center text-[12.5px] text-muted">
                示範畫面。實際回答由 AI 即時生成，每次不完全一樣。
              </p>
            </Reveal>
          </div>
        </section>

        {/* ── 3. 她是誰 ────────────────────────────────────────── */}
        <section className="lz-section border-y-2 border-ink bg-teal-wash">
          <div className="lz-wrap">
            <SectionHead
              eyebrow="她是誰"
              title={
                <>
                  中文系教授，
                  <br />
                  也是台灣婦運的起點之一。
                </>
              }
            />

            <Reveal delay={0.08}>
              <div className="mt-6 max-w-[720px] space-y-4 text-[15.5px] leading-relaxed text-ink-soft">
                <p>
                  李元貞，1946 年生於雲南昆明，1949 年隨父母來台，在高雄左營的軍眷區長大，
                  1964 年自花蓮女中畢業。台大中文系學士、碩士，1971 年起在淡江大學中文系任教三十餘年。
                </p>
                <p>
                  1982 年她創辦《婦女新知》雜誌社，1987 年改組為婦女新知基金會並出任第一屆董事長。
                  2005 年她未達屆齡就主動從淡江退休，遷居花蓮，花了近九年寫成《眾女成城》。
                  2023 年，她把花蓮住所的 1,200 冊藏書全數捐給國立東華大學圖書館，設立「李元貞文庫」。
                </p>
              </div>
            </Reveal>

            <Reveal delay={0.14}>
              <div className="mt-10 grid gap-4 md:grid-cols-3">
                {WORKS.map((w) => (
                  <Link
                    key={w.title}
                    href={`/chat?q=${encodeURIComponent(w.ask)}`}
                    className="lz-card lz-card-link flex h-full flex-col p-5"
                  >
                    <h3 className="font-display text-[16px] font-bold leading-snug">
                      《{w.title}》
                    </h3>
                    <p className="mt-2 text-[12.5px] text-muted">{w.meta}</p>
                    <p className="mt-3 flex-1 text-[14px] leading-relaxed text-ink-soft">
                      {w.body}
                    </p>
                    <span className="mt-4 text-[13px] font-bold text-teal underline underline-offset-2">
                      問她這本 →
                    </span>
                  </Link>
                ))}
              </div>
            </Reveal>

            <Reveal delay={0.18}>
              <div className="mt-8">
                <Link href="/chat?q=李元貞還寫過哪些書？" className="lz-cta-ghost">
                  問她其他著作 →
                </Link>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── 4. 婦運歷程 ──────────────────────────────────────── */}
        <section className="lz-section bg-rose-wash">
          <div className="lz-wrap">
            <SectionHead
              eyebrow="婦運歷程"
              title={
                <>
                  從一本雜誌，
                  <br />
                  到一條一條的法律。
                </>
              }
              lead="十件事，四十年。點任何一件，數位李元貞會接著講那一段。"
            />

            {/* ⚠️ Reveal 包在 <ol> 外層，不可以每個 <li> 包一次——
                它渲染的是 <div>，插進 ol > li 之間是無效 HTML。 */}
            <Reveal delay={0.1}>
              <ol className="lz-timeline mt-10">
                {TIMELINE.map((item) => (
                  <li key={`${item.year}-${item.title}`}>
                    <Link
                      href={`/chat?q=${encodeURIComponent(item.ask)}`}
                      className="lz-card lz-card-link block p-5 sm:p-6"
                    >
                      <span className="lz-pill">{item.year}</span>
                      <h3 className="mt-3 font-display text-[17px] font-bold sm:text-[19px]">
                        {item.title}
                      </h3>
                      <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">{item.body}</p>
                      {"note" in item && item.note && (
                        <p className="mt-2 text-[12.5px] leading-relaxed text-muted-light">
                          {item.note}
                        </p>
                      )}
                      <span className="mt-3 inline-block text-[13px] font-bold text-rose underline underline-offset-2">
                        問她這件事 →
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </Reveal>

            <Reveal delay={0.14}>
              <p className="mt-8 text-[12.5px] text-muted">
                資料來源：婦女新知基金會大事紀、臺灣女人（國立臺灣歷史博物館）
              </p>
              <div className="mt-5">
                <Link href="/live" className="lz-cta">
                  想聽她自己講？面對面問她 →
                </Link>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── 5. 她說過的話 ────────────────────────────────────── */}
        <section className="lz-section border-y-2 border-ink bg-violet">
          <div className="lz-wrap">
            <SectionHead
              eyebrow="她說過的話"
              tone="light"
              title="這些話，是她自己說的。"
              lead="引文出自公開的專訪、講綱與《眾女成城》。點一句，可以接著問那句話的來由。"
            />

            <Reveal delay={0.1}>
              <div className="mt-10 grid items-start gap-4 md:grid-cols-2">
                {QUOTES.map((q) => (
                  <figure key={q.text} className="lz-card flex h-full flex-col p-6">
                    <blockquote className="font-display text-[18px] font-bold leading-relaxed">
                      「{q.text}」
                    </blockquote>
                    <figcaption className="mt-3 flex-1 text-[13px] leading-relaxed text-muted">
                      {q.context}
                    </figcaption>
                    <Link
                      href={`/chat?q=${encodeURIComponent(q.ask)}`}
                      className="lz-chip mt-4 self-start"
                    >
                      問這句的來由
                    </Link>
                  </figure>
                ))}
              </div>
            </Reveal>

            {/* 闢謠。這是全站最能證明「這個 AI 不會順著你講」的一段。 */}
            <Reveal delay={0.14}>
              <div className="lz-card-wash mt-8 p-6">
                <span className="lz-pill">常見誤植</span>
                <h3 className="lz-h3 mt-3">這一句，不是她說的。</h3>
                <blockquote className="mt-4 font-display text-[17px] font-bold leading-relaxed">
                  「{MISATTRIBUTED.text}」
                </blockquote>
                <p className="mt-3 text-[14px] leading-relaxed text-ink-soft">
                  {MISATTRIBUTED.truth}
                </p>
                <p className="mt-4 text-[13.5px] text-ink-soft">
                  你問數位李元貞這句是不是她說的，她也會告訴你不是。
                </p>
                <Link
                  href={`/chat?q=${encodeURIComponent(MISATTRIBUTED.ask)}`}
                  className="lz-chip mt-4 inline-flex"
                >
                  試試看
                </Link>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── 6. 這個 AI 是什麼 ─────────────────────────────────── */}
        <section className="lz-section bg-paper">
          <div className="lz-wrap">
            <SectionHead
              eyebrow="先說清楚"
              title={
                <>
                  用她的名字說話，
                  <br />
                  更要說清楚。
                </>
              }
            />

            <Reveal delay={0.1}>
              <div className="mt-9 grid gap-4 md:grid-cols-3">
                {[
                  {
                    h: "它不是李元貞本人",
                    p: "「數位李元貞」是一個 AI 分身。肖像與聲音經老師書面授權使用，但影片裡的話是 AI 生成的，不代表她的立場，她也無須為內容負責。",
                  },
                  {
                    h: "它只依公開資料回答",
                    p: "知識庫取自她的著作、維基百科、婦女新知基金會的公開資料與公開報導，沒有使用任何未出版的書稿。找不到夠相關的段落時，它會直接說超出範圍，不會自己編一個答案。",
                  },
                  {
                    h: "它會答錯",
                    p: "AI 生成的內容可能有誤，重要資訊請以老師的著作與正式出版品為準。發現錯誤歡迎告訴我們，會直接修正知識庫。",
                  },
                ].map((c) => (
                  <div key={c.h} className="lz-card h-full p-5">
                    <h3 className="font-display text-[16px] font-bold">{c.h}</h3>
                    <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">{c.p}</p>
                  </div>
                ))}
              </div>
              <p className="mt-5 text-[13px] text-muted">
                提問內容會被記錄，用於改善回答品質。請不要在對話中輸入個人資料。
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Link href="/about-ai" className="lz-cta">
                  這個 AI 怎麼運作 →
                </Link>
                <Link href="/privacy" className="lz-cta-ghost">
                  隱私權說明
                </Link>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── 7. 現在換你問 ────────────────────────────────────── */}
        <section className="lz-section border-t-2 border-ink bg-brand">
          <div className="lz-wrap text-center">
            <Reveal>
              <h2 className="lz-h2">現在，換你問。</h2>
              <p className="lz-lead mx-auto mt-4 !text-ink-soft">
                按住說話，她用自己的聲音回答。不方便出聲，就用文字。
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <Link href="/live" className="lz-cta">
                  面對面問她 →
                </Link>
                <Link href="/chat" className="lz-cta-ghost">
                  文字對話
                </Link>
              </div>
              <p className="mt-8 text-[13.5px] text-ink-soft">
                活動場次確認後會在這裡公布。{" "}
                <Link href="/events" className="font-bold underline underline-offset-2">
                  看活動資訊
                </Link>
              </p>
            </Reveal>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
