-- ═══════════════════════════════════════════════════════════════
-- 0006 後台人員管理（兩層角色）＋ 操作稽核日誌
--
-- ⚠️ 這個專案沒有 migration runner。這份 SQL 要手動貼進
--    Supabase Dashboard 的 SQL Editor，或走 Management API：
--      POST https://api.supabase.com/v1/projects/{ref}/database/query
--    （用 curl 不要用 python 的 urllib，Cloudflare 會用 1010 擋掉。）
--
-- 🔴 這份 SQL **完全不碰 `has_role()`**，那是刻意的。
--    `lib/admin-auth.ts` 的 `isStaff()` / `isManager()` 都靠它，而且查詢失敗時
--    一律保守回 false。把它 create or replace 壞掉，或撤掉它的 grant，
--    後果是**所有人同時被鎖在後台外面**——包含要進去修的那個人。
--    這一份只「新增」函式，不改既有的。
--
-- 🔴 跑這份之前，`app_role` enum 只有 'admin'（實測：用 'editor' 呼叫 has_role
--    會回 22P02 invalid input value）。下面第一節加上 'editor'。
--
-- ⚠️⚠️ 整份 SQL **不可以出現 'editor' 這個字面值**（除了 add value 那一行）。
--    Postgres 規定：`alter type ... add value` 新增的值，在**同一個 transaction 裡
--    不能被使用**。而 SQL Editor 一次貼整份會落在同一個 implicit transaction，
--    所以任何 `... = 'editor'` 或 `check (role in ('admin','editor'))` 都會讓
--    整份 migration 失敗。第一次真正用到它是之後從後台 UI 新增小編的時候，
--    那已經是另一個 transaction。
--    👉 以後若要在 SQL 裡用到新的 enum 值，**必須另開一份 migration 分兩次跑**。
--
-- 部署順序：**先跑這份 SQL，再部署程式碼。**
--    反過來也不會壞（程式碼對「表還沒建」有降級處理），但那段期間
--    「最後一個管理員」的保護還不存在。
-- ═══════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════
-- 一、第二個角色：小編
-- ═══════════════════════════════════════════════════════════════

-- 管理員（admin）＝全部，含人員管理與看稽核日誌
-- 小編（editor）＝場次上架、報名名單、問答紀錄，但不能管人、不能看日誌
alter type app_role add value if not exists 'editor';


-- 「這個人在不在後台白名單裡」——不分層級。
--
-- ⚠️ 刻意寫成「在 user_roles 有任何一列」而不是 `role in ('admin','editor')`：
--    一來避開上面那個 enum／transaction 限制，二來以後再加角色時
--    這支不用跟著改。分層級的判斷用既有的 `has_role(uid, 'admin')`。
--
-- ⚠️ security definer ＋ set search_path 的理由跟 0004 的 has_role 一模一樣：
--    要查得到呼叫者自己看不到的列；不鎖 search_path 的話呼叫者可以換掉
--    user_roles 這個名字，讓函式去查一張假表。
create or replace function has_any_role(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from user_roles where user_id = _user_id)
$$;

-- 🔴 跟 0004 對 has_role 做的一樣，這兩行不可以省。
--    security definer 的函式建在 public schema 底下，PostgREST 預設會把它
--    開成一支任何人都能打的 RPC——包含只拿著 anon key 的路人。
revoke all on function has_any_role(uuid) from public, anon;
grant execute on function has_any_role(uuid) to authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════
-- 二、收緊 user_roles 的權限
-- ═══════════════════════════════════════════════════════════════

-- 🔴 0004 建這張表時沒有下過任何 revoke，而 Supabase 的 default privileges
--    會把 public schema 的新表 grant 給 anon 與 authenticated。
--    實測（2026-09-21）：用 anon key 打 GET /rest/v1/user_roles 回的是
--    **HTTP 200 []**，不是 401——代表 grant 還在，擋住的只有「RLS 開著、
--    沒有符合的 policy」這一層。policy 一旦被誰改錯，管理員名單就外流了。
--
--    收成兩層：權限層先擋掉，RLS 是第二道。
revoke all on table user_roles from anon, authenticated;

-- ⚠️ 補回 select 是為了讓 0004 的 `read own roles` policy 真的有作用。
--    policy 只會「縮限」不會「授予」——沒有 grant 的 policy 是裝飾品，
--    而 0004 的註解寫著「登入者只讀得到自己的角色」，那句話現在才成真。
--    讀自己的角色是無害的；讀別人的仍然被 policy 擋住。
grant select on table user_roles to authenticated;
grant all on table user_roles to service_role;

-- 🔴 刻意**不**建 insert/update/delete policy，也不 grant 寫入給 authenticated。
--
--    台大農經那邊是加了 policy、並讓寫入走 session client，理由是
--    「兩步都用 service_role 的話 policy 永遠不會被執行到」。那個理由成立，
--    但在這個站上會開出一條更糟的路：
--
--    `components/admin/../LoginForm.tsx` 用的是 `createAuthBrowserClient()`，
--    也就是 **anon key ＋ 管理員的 session 本來就活在瀏覽器裡**。一旦
--    grant + policy 到位，任何管理員在 devtools console 打一行
--      await supabase.from('user_roles').insert({ user_id: '…', role: 'admin' })
--    就會成功，**而且不會留下任何稽核紀錄**——因為日誌是伺服器端寫的。
--    後台區的 XSS、被汙染的 npm 套件，都走得通這條路。
--
--    這個站的稽核是應用層寫的（理由見第四節），所以「所有寫入都必須經過
--    伺服器」是稽核可信的前提。service_role 金鑰不離開伺服器，這個前提才成立。
--
--    代價：少了「server action 忘記 requireManager() 時由 DB 兜底」這一層。
--    改用 `lib/audit/coverage.test.ts` 在 build 時期擋——那條測試掃每一支
--    action 有沒有 requireManager/requireStaff 與 writeAudit，跑 npm test 就會紅。


-- ═══════════════════════════════════════════════════════════════
-- 三、保底：至少留一位管理員
-- ═══════════════════════════════════════════════════════════════

create or replace function keep_one_admin()
returns trigger
language plpgsql
-- 🔴 SECURITY DEFINER 不可省。user_roles 有 RLS，而它唯一的 policy 是
--    「只讀得到自己的角色」。這支函式若以觸發者的身分執行，它數到的會是
--    0 或 1，而不是真實人數——守門的正確性會變成取決於「誰在執行它」。
--    （今天寫入走 service_role 本來就繞過 RLS，所以看不出差別。
--      哪天有人改用 session client 寫入就會靜默誤判。）
security definer
set search_path = public
as $$
begin
  -- 🔴 先鎖表再數。
  --    不鎖的話，兩位管理員「同時互相移除」會兩邊都通過：READ COMMITTED 下
  --    各自的交易都還看得到對方那一列，各自算出「還剩 1 個」，雙雙 commit，
  --    表就空了。台大那一支有這個漏洞。
  --    兩人同時升級鎖時可能死鎖——沒關係，Postgres 會砍掉其中一筆，
  --    而「寫入被拒絕」正是這裡想要的結果。
  lock table user_roles in exclusive mode;

  if (select count(*) from user_roles where role = 'admin') = 0 then
    raise exception 'LAST_ADMIN';
  end if;
  return null;
end
$$;

comment on function keep_one_admin() is
  'user_roles 至少要留一位 admin。AFTER STATEMENT 觸發，內含表鎖以擋並行互刪。';

-- ⚠️ AFTER STATEMENT，不是 BEFORE ROW。
--    BEFORE ROW 看到的是「這一列還沒被刪」，所以 `delete from user_roles`
--    一次刪光會在第一列上誤判成「還有很多列」而放行。
--
-- ⚠️ 一定要同時掛 update。兩個理由：
--    (a) `update user_roles set user_id = <別人>` 今天就能把最後一位管理員換掉
--    (b) 現在有了小編這個角色，「把最後一位管理員降成小編」的後果與刪除一模一樣
--
-- 🔴 這支 trigger 同時擋住四條把所有人鎖在門外的路，其中最隱蔽的一條是
--    「刪掉最後一位管理員的 auth 帳號」——UI 上那看起來跟 user_roles 無關，
--    但 0004 的外鍵是 `on delete cascade`，GoTrue 刪 auth.users 會連帶刪掉
--    user_roles 那一列，而 cascade 刪除**會**觸發這支 trigger，
--    於是整個刪除（連同 auth.users）一起 rollback。
drop trigger if exists user_roles_keep_one_admin on user_roles;
create trigger user_roles_keep_one_admin
  after delete or update on user_roles
  for each statement execute function keep_one_admin();


-- ═══════════════════════════════════════════════════════════════
-- 四、操作稽核日誌
-- ═══════════════════════════════════════════════════════════════

-- 🔴 這張表由**應用層**寫入（`lib/audit/index.ts` 的 writeAudit），
--    不是 DB trigger。這跟台大農經的作法相反，理由是結構性的：
--
--    台大的 trigger 靠 `auth.uid()` 蓋章，而且只在它非 null 時才記錄。
--    這個站的後台寫入全部走 `createAdminSupabase()`（service_role），
--    `auth.uid()` 永遠是 NULL——照抄的話**一筆都不會記，而且不會報錯**。
--
--    更關鍵的是：建帳號、設密碼、刪帳號都發生在 GoTrue，不在任何一張
--    我們擁有的表上，沒有 trigger 看得到。台大的「重設密碼」就是因為這樣
--    在他們的日誌裡完全不存在。而這一版的功能核心正是「新增管理員時
--    直接設初始密碼」，密碼相關動作是主角不是邊角。
create table if not exists admin_audit_log (
  id bigint generated always as identity primary key,

  -- 🔴 刻意沒有外鍵指向 auth.users。
  --    「刪除管理員帳號」本身就是這張表會記錄的動作之一；加了外鍵的話，
  --    那位操作者日後被刪除時，他留下的每一筆日誌都會違反外鍵。台大實測撞過：
  --    刪帳號 cascade 掉名冊列，而記錄那次刪除的日誌又要引用正在被刪的人。
  --    而且「同時存 email 快照」與「加外鍵」是自相矛盾的——快照存在的理由
  --    就是這個帳號可能會消失。這是 append-only 的事實紀錄，
  --    不是需要維持參照完整性的關聯表。
  actor_id uuid,
  -- ⚠️ 快照，不 join。帳號刪掉之後仍然看得出是誰做的。
  actor_email text,

  action text not null,
  -- 領域名詞（event / admin），不是表名。
  -- ⚠️ 台大用的是 tg_table_name，因為 trigger 手上只有那個。應用層寫入讓
  --    「admin」一個詞就能涵蓋跨 auth.users 與 user_roles 的動作。
  entity text not null,
  -- ⚠️ text 不是 uuid：帳號被刪之後這個值仍要留著，這裡不需要參照完整性。
  entity_id text,
  label text,

  created_at timestamptz not null default now()
);

alter table admin_audit_log drop constraint if exists admin_audit_log_action_valid;
alter table admin_audit_log
  add constraint admin_audit_log_action_valid
  -- ⚠️ 這個清單與 `lib/audit/types.ts` 的 AuditAction union 是同一份合約的兩半，
  --    改一邊要改兩邊（types.test.ts 有一條在比對它們）。
  --
  -- 🔴 revoke（移除權限，可逆）與 delete（刪帳號，不可逆）刻意分開。
  --    後台把這兩個按鈕分開的全部理由就是可逆性不同，日誌不該把那個區分丟掉。
  -- 🔴 password 是台大沒有的：他們的 trigger 看不到 GoTrue 的動作。
  check (action in ('insert', 'update', 'delete', 'revoke', 'password'));

create index if not exists admin_audit_log_recent
  on admin_audit_log (created_at desc);
create index if not exists admin_audit_log_by_entity
  on admin_audit_log (entity, created_at desc);

alter table admin_audit_log enable row level security;

-- 🔴 「RLS 開著、零 policy」＝ 只有 service_role 進得來。
--    這跟 0001 對 interactions 的處理一致，而且比台大更緊——台大開了一條
--    manager 的 select policy，那需要 grant select 給 authenticated，
--    等於讓日誌從瀏覽器用 anon key 讀得到。這一頁的讀取走伺服器端的
--    createAdminSupabase()，完全不需要那條路。
--
--    結果是：沒有任何登入者能偽造一筆，也沒有任何登入者能抹掉自己的紀錄。
--    一份當事人改得動的稽核日誌沒有意義。
--
-- ⚠️ revoke 要明寫，不要倚賴預設（見第二節那段實測）。
revoke all on table admin_audit_log from anon, authenticated;
grant all on table admin_audit_log to service_role;


-- ═══════════════════════════════════════════════════════════════
-- 五、跑完之後的權限實況
-- ═══════════════════════════════════════════════════════════════
--
--                         anon        authenticated           service_role
--   user_roles            ✗ 全關      select 自己那列          全部
--   admin_audit_log       ✗ 全關      ✗ 全關                  全部
--   has_role()            ✗          ✓                       ✓
--   has_any_role()        ✗          ✓                       ✓
--
-- 驗收（用 curl，不要用 python）：
--   curl -s -o /dev/null -w '%{http_code}\n' \
--     "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/admin_audit_log?select=*" \
--     -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"
--   👉 期望 401，**不是 200 加一個空陣列**。回 [] 代表 grant 還在。
--
-- 「最後一位管理員」的 trigger 怎麼安全地測（包在一定會 rollback 的交易裡）：
--   begin;
--     delete from user_roles where role = 'admin';   -- 期望 ERROR: LAST_ADMIN
--   rollback;
--   trigger 正常 → 語句報錯、交易中止、rollback 是 no-op
--   trigger 壞了 → 語句成功、但 rollback 把它撤掉
--   兩種情況都不會真的鎖門。
