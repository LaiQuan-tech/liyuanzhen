-- 虛擬人 session 帳本：並發水位與月度預算的唯一真相來源。
--
-- 為什麼一定要落在資料庫而不是行程內的變數：
-- Vercel 是多實例的，行程內的 Map 每個實例各算各的。四個實例各以為自己只用了
-- 10 個並發，實際上是 40，然後同時撞上 HeyGen 的天花板——而那一層沒有優雅的失敗，
-- 它會直接回錯誤，官方連並發專用的錯誤碼都沒定義。
--
-- 這張表就是「不要讓請求打到 HeyGen 天花板」這件事的實作。

create table if not exists avatar_sessions (
  -- LiveAvatar 回傳的 session_id。用它當主鍵，重複開同一個 session 會被擋掉。
  id                text primary key,
  started_at        timestamptz not null default now(),
  -- 收到關閉訊號才會填。⚠️ 大多數 session 永遠不會有值——見下方 stale 說明。
  ended_at          timestamptz,
  -- 實際計費分鐘數（無條件進位，跟帳單同一套算法）。結束或判定逾時才填。
  billed_minutes    integer,
  -- 粗略的來源識別，只用來擋「同一個人狂開 session」。
  -- ⚠️ 存雜湊不存原始 IP：這是開放給不特定大眾的公開網站，
  --    沒有必要、也不該保留可直接識別個人的連線紀錄。
  client_hash       text,
  -- 開這個 session 時我們用的單次上限，用來回推逾時判定
  max_seconds       integer not null
);

-- 並發水位查詢：數「還沒結束、而且還沒逾時」的。這是每次發 token 前都會跑的查詢，
-- 一定要有索引，否則公眾流量下它會變成瓶頸。
create index if not exists avatar_sessions_active_idx
  on avatar_sessions (started_at desc)
  where ended_at is null;

-- 月度用量查詢
create index if not exists avatar_sessions_started_idx
  on avatar_sessions (started_at desc);

alter table avatar_sessions enable row level security;

-- 沒有任何 policy = 只有 service_role 進得來。
-- 這張表沒有任何一欄需要讓瀏覽器讀到，並發水位與預算餘額都由 API 回傳彙總值。
-- 讓前端讀得到這張表等於告訴攻擊者「現在還剩幾個名額」。

comment on table avatar_sessions is
  '虛擬人串流 session 帳本。並發與預算的閘門在應用層（lib/avatar-ledger），'
  '這張表是跨 Vercel 實例的共用計數器。';

comment on column avatar_sessions.ended_at is
  '⚠️ 大多數列永遠是 null。公開網站的訪客會直接關分頁、切 app、鎖屏，'
  '不會送關閉訊號。判定活著與否一律用 started_at + max_seconds + 緩衝，'
  '不要相信這一欄。已知 HeyGen 上大量開發者回報「0 個 session 在跑卻仍報 '
  'Concurrent Limit Reached」，原因就是殭屍 session 沒清乾淨。';
