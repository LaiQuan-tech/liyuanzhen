-- 網站表單：提問牆、活動報名、電子報
-- Stage 2 才會用到；Stage 1 的表單只顯示展示版說明，不寫資料。

create table if not exists reader_questions (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  nickname text,
  -- 預設不公開，要由人審過才會出現在提問牆上
  is_published boolean not null default false,
  reply text,
  created_at timestamptz not null default now()
);

create table if not exists event_signups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  event_key text not null,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);

alter table reader_questions enable row level security;
alter table event_signups enable row level security;
alter table newsletter_subscribers enable row level security;

-- 匿名訪客只能「寫入」，不能讀取別人留下的資料。
-- 讀取一律走 service_role（後台）。
create policy "anon can insert questions"
  on reader_questions for insert to anon with check (true);

create policy "anon can insert signups"
  on event_signups for insert to anon with check (true);

create policy "anon can subscribe"
  on newsletter_subscribers for insert to anon with check (true);

-- 已審核的提問可公開讀取，其餘不行
create policy "published questions are public"
  on reader_questions for select to anon using (is_published = true);
