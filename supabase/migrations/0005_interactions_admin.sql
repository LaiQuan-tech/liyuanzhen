-- 0005_interactions_admin.sql
-- 讓後台看得到「民眾問了什麼」。2026-09-01。
--
-- ⚠️ 這個專案沒有 migration runner。這份 SQL 要手動貼進
-- Supabase Dashboard 的 SQL Editor，或走 Management API：
--   POST https://api.supabase.com/v1/projects/{ref}/database/query
-- （用 curl 不要用 python 的 urllib，Cloudflare 會用 1010 擋掉。）
--
-- interactions 表本身在 0001 就建好了，這份只補兩個欄位。


-- ─────────────────────────────────────────────────────────────
-- 1. failed：這一筆到底是不是「一個真的回答」
-- ─────────────────────────────────────────────────────────────
--
-- 🔴 這一欄存在的理由：Gemini 生成失敗時，程式把固定文案
-- 「抱歉，我這邊出了點狀況，請稍後再試一次。」當成 answer_summary 存進去，
-- 而且 in_scope=true、blocked=false——在資料庫裡跟一個成功的回答完全一樣。
--
-- 後台這一頁的用途就是判斷數位人答得好不好。把當機訊息讀成 AI 的回答，
-- 結論會整個歪掉：會以為語料有問題，而其實是 API 掛了。
-- 實測正式站 144 筆裡有 6 筆是這種。
--
-- 檢索失敗（retrieve() 丟例外）也走這一欄。那條路徑會降級成 in_scope=false，
-- 跟「訪客真的問了不相干的事」混在一起，同樣需要分開。
alter table interactions add column if not exists failed boolean not null default false;


-- ─────────────────────────────────────────────────────────────
-- 2. channel：這個問題是打字來的還是講話來的
-- ─────────────────────────────────────────────────────────────
--
-- /live 的鏈路是：麥克風 → /api/stt 轉逐字稿 → 逐字稿當一般文字丟進 /api/chat。
-- 所以到了寫入這一步，語音提問跟打字提問長得一模一樣，表裡沒有任何欄位分得出來。
--
-- ⚠️ 想用 avatar_sessions 反推是行不通的：那張表的 id 是 HeyGen 回傳的 session_id，
-- interactions.session_id 是瀏覽器自己產的 crypto.randomUUID()，兩套 id join 不起來。
-- 而且 /chat 頁面也會開虛擬人，「有 avatar session」不等於「是語音頁」。
--
-- 可以是 null——既有的 144 筆補不回來，這是接受的。
-- 但要現在加：不加的話往後每一天的資料都同樣分不出來，而回填永遠不可能。
alter table interactions add column if not exists channel text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'interactions_channel_check'
  ) then
    alter table interactions
      add constraint interactions_channel_check
      check (channel is null or channel in ('chat', 'live'));
  end if;
end $$;


-- ─────────────────────────────────────────────────────────────
-- 3. 回填既有的當機紀錄
-- ─────────────────────────────────────────────────────────────
--
-- 歷史資料只能靠字串比對認出來。不跑這一段的話，後台會永遠把那 6 筆
-- 當成正常回答——而它們正是最需要被看見的（代表那幾次訪客問了問題卻沒得到答案）。
--
-- ⚠️ 這裡寫死的字串必須跟 app/api/chat/route.ts 的 FALLBACK_REPLY 一致。
-- 改了那個常數，這一段對更早的資料就失效了（新資料無所謂，走 failed 欄位）。
update interactions set failed = true
 where failed = false
   and answer_summary like '抱歉，我這邊出了點狀況%';


-- ─────────────────────────────────────────────────────────────
-- 4. RLS：什麼都不要做
-- ─────────────────────────────────────────────────────────────
--
-- 🔴 interactions 目前是「RLS 開著、零 policy」＝只有 service_role 進得來
-- （0001 第 66-69 行）。這是對的，不要為了後台方便加任何 policy。
--
-- 後台的讀取走 createAdminSupabase()（service_role，在伺服器端），
-- 不需要 anon 有任何權限。加一條 anon select policy 等於把所有訪客的
-- 提問原文攤開給任何拿得到 anon key 的人——而 anon key 是寫在前端原始碼裡的。
--
-- 提問是自由文字，訪客可能自己打了電話、住址進去。這張表比報名名單更難預測。


-- ─────────────────────────────────────────────────────────────
-- 5. 索引：這一版不加
-- ─────────────────────────────────────────────────────────────
--
-- 0001 已經有 interactions_created_at_idx on (created_at desc)，
-- 後台預設就是照時間倒序翻頁，那一個就夠。
-- in_scope / blocked / failed 的篩選在 144 筆（每週約 30 筆）的規模下
-- 全表掃描比索引快，等長到幾萬筆再說。
