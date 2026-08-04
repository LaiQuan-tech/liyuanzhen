-- 知識庫與互動記錄
-- 以 Sunny/exhibit-ai-kiosk 的 0001 為底，含三項修正（見各處註解）

create extension if not exists vector;

create table if not exists knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  -- 修正①：新增來源連結與標題，讓前端能顯示真實引用
  source_url text not null default '',
  title text not null default '',
  content text not null,
  embedding vector(768) not null,
  created_at timestamptz not null default now()
);

-- 修正②：改用 hnsw。原版 ivfflat with (lists = 100) 在幾十列的小語料上
-- 召回率會非常糟（分群數遠大於資料量）；hnsw 不需訓練資料，任何規模都正確。
create index if not exists knowledge_chunks_embedding_idx
  on knowledge_chunks using hnsw (embedding vector_cosine_ops);

create index if not exists knowledge_chunks_source_idx on knowledge_chunks (source);

-- 修正③：match_count 預設改 8，與 lib/retrieval/index.ts 的 TOP_K 一致。
-- 相似度門檻刻意「不」放在 SQL 裡——留在 retrieval/index.ts 才能保證
-- local 與 supabase 兩個 provider 的行為完全相同。
create or replace function match_knowledge_chunks(
  query_embedding vector(768),
  match_count int default 8
)
returns table (
  id uuid,
  source text,
  source_url text,
  title text,
  content text,
  similarity float
)
language sql stable
as $$
  select
    id,
    source,
    source_url,
    title,
    content,
    1 - (embedding <=> query_embedding) as similarity
  from knowledge_chunks
  order by embedding <=> query_embedding
  limit match_count;
$$;

create table if not exists interactions (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  question_text text not null,
  answer_summary text not null,
  top_similarity real,
  in_scope boolean not null default true,
  blocked boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists interactions_created_at_idx on interactions (created_at desc);

-- 原版完全沒有 RLS。這兩張表只由 service_role 存取，
-- 但仍要開 RLS，避免將來不小心把 anon key 接上來就整包外洩。
alter table knowledge_chunks enable row level security;
alter table interactions enable row level security;
-- 不建立任何 policy = 只有 service_role 進得來（service_role 本來就繞過 RLS）
