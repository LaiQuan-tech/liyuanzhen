-- 活動上架後台 ＋ 線上報名
--
-- ⚠️ 這個專案沒有 migration runner，這份 SQL 要貼到 Supabase Dashboard 的
-- SQL Editor 手動跑。跑之前先確認你在對的專案（這份會建立 auth 相關的權限表）。

-- ═══════════════════════════════════════════════════════════════
-- 一、權限模型
-- ═══════════════════════════════════════════════════════════════
--
-- 為什麼要一張 user_roles 而不是在 auth.users 上加欄位：
-- auth schema 是 Supabase 管的，不該去改它；而且角色是「這個站的概念」，
-- 放在自己的 schema 裡才有辦法連同 RLS 一起版本控管。

do $$ begin
  create type app_role as enum ('admin');
exception when duplicate_object then null; end $$;

create table if not exists user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

alter table user_roles enable row level security;

-- 登入者只讀得到自己的角色。讀得到別人的等於把管理員名單公開。
drop policy if exists "read own roles" on user_roles;
create policy "read own roles"
  on user_roles for select to authenticated
  using (auth.uid() = user_id);

-- ⚠️ security definer：這支函式要以「函式擁有者」的權限執行，才查得到
-- 呼叫者自己看不到的列。set search_path 是必要的——沒有它，呼叫者可以
-- 用自己的 search_path 換掉 user_roles 這個名字，讓函式去查一張假表。
create or replace function has_role(_user_id uuid, _role app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from user_roles where user_id = _user_id and role = _role
  )
$$;

-- 🔴 這兩行不可以省。
-- security definer 的函式建在 public schema 底下，PostgREST 預設會把它
-- 開成一支任何人都能打的 RPC——包含只拿著 anon key 的路人。
-- 不 revoke 的話，等於免費送一個「幫我查這個 uuid 是不是管理員」的探測端點。
revoke all on function has_role(uuid, app_role) from public, anon;
grant execute on function has_role(uuid, app_role) to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════
-- 二、活動
-- ═══════════════════════════════════════════════════════════════

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  -- 網址代稱。公開頁是 /events/{slug}，所以它要能出現在網址裡
  slug text not null unique,
  subtitle text,
  description text,
  event_date date not null,
  start_time time,
  end_time time,
  venue text,
  address text,
  -- 「免費入場，額滿為止」這類補充。刻意不做名額欄位——
  -- 名額要連帶候補、取消、遞補三種狀態，這一版不做。
  registration_note text,
  -- draft：還在寫，公開端看不到
  -- published：公開端看得到，可以報名
  -- closed：公開端看得到，但不能再報名（活動結束或截止）
  status text not null default 'draft' check (status in ('draft', 'published', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists events_date_idx on events (event_date desc);
create index if not exists events_status_idx on events (status) where status = 'published';

alter table events enable row level security;

-- ⚠️ 只有 published 才對外可讀。草稿裡可能有還沒談定的講者、還沒確認的地點，
-- 那些東西外流的後果是真實的（有人跑去一個還沒訂下來的場地）。
drop policy if exists "published events are public" on events;
create policy "published events are public"
  on events for select to anon, authenticated
  using (status = 'published');

grant select on events to anon, authenticated;
grant all on events to service_role;

-- ═══════════════════════════════════════════════════════════════
-- 三、報名
-- ═══════════════════════════════════════════════════════════════

create table if not exists event_registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  name text not null,
  email text not null,
  phone text,
  party_size integer not null default 1 check (party_size between 1 and 10),
  note text,
  -- 個資同意。⚠️ not null 且沒有預設值：每一筆都必須明確記下當事人同意過。
  -- 給預設 true 等於替他按同意。
  consent boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists event_registrations_event_idx
  on event_registrations (event_id, created_at desc);

alter table event_registrations enable row level security;

-- 🔴 anon 一律拒絕，讀寫都是。
--
-- 這張表裡是姓名、信箱、電話——全站第一次蒐集可直接識別個人的資料。
-- 常見的錯是開一條 "anon can insert" 就讓瀏覽器直接寫，那樣做的問題不是寫入，
-- 是那把 anon key 會出現在前端原始碼裡，而 insert 權限一旦有人拿去試，
-- select policy 只要哪天寫鬆一格，整份名單就攤開了。
-- 報名一律走 /api/events/[slug]/signup（service_role），前端拿不到任何金鑰。
drop policy if exists "registrations deny anon" on event_registrations;
create policy "registrations deny anon"
  on event_registrations for all to anon, authenticated
  using (false) with check (false);

grant all on event_registrations to service_role;

-- ═══════════════════════════════════════════════════════════════
-- 四、updated_at 自動更新
-- ═══════════════════════════════════════════════════════════════

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists events_touch_updated_at on events;
create trigger events_touch_updated_at
  before update on events
  for each row execute function touch_updated_at();

-- ═══════════════════════════════════════════════════════════════
-- 五、建立第一個管理員（跑完上面之後，手動做這一步）
-- ═══════════════════════════════════════════════════════════════
--
-- ⚠️ 刻意**不做**自助 bootstrap 端點。那種端點的邏輯是「目前沒有管理員時，
-- 任何人都可以把自己設成管理員」——只要漏擋一次，或是有人在正式站上搶在
-- 你之前打它，整個後台就是別人的。多花兩分鐘手動做，換掉這個風險。
--
-- 步驟：
--   1. Supabase Dashboard → Authentication → Users → Add user
--      填基金會承辦人的信箱與密碼（勾 Auto Confirm User）
--   2. 複製那個 user 的 UUID
--   3. 回到 SQL Editor 跑：
--
--      insert into user_roles (user_id, role)
--      values ('把 UUID 貼在這裡', 'admin');
--
--   4. 要加第二個管理員就重複 1~3

-- ═══════════════════════════════════════════════════════════════
-- 六、（可選）清掉沒有人用的舊表
-- ═══════════════════════════════════════════════════════════════
--
-- event_signups 建於 0002_site_forms.sql，但從來沒有任何程式碼寫入過
-- （2026-08-31 實測 0 筆），而且欄位形狀對不上：沒有 event_id、沒有電話、
-- 沒有同意欄位。留著只會讓下一個人搞不清楚該用哪一張。
--
-- 要清就跑這一行；不確定就先留著，它不會影響任何東西。
--
--   drop table if exists event_signups;
