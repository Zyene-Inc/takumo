-- Run once in the Supabase SQL editor after the first `pnpm migrate`.
-- 1) pgvector for document search  2) RLS as a backstop for tenant isolation.
--
-- WorkOS is connected to Supabase as a third-party auth provider
-- (Supabase → Authentication → Third-party auth → WorkOS), so the WorkOS
-- access token is available as auth.jwt(). Its `org_id` claim holds the
-- active organization.

create extension if not exists vector;

create index if not exists doc_chunk_embedding_idx
  on "DocChunk" using hnsw (embedding vector_cosine_ops);

create or replace function public.current_org_id() returns text
  language sql stable
as $$
  select auth.jwt() ->> 'org_id'
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'Member', 'WorkCenter', 'CalendarDay', 'Operator', 'Material', 'Customer',
    'Part', 'Routing', 'BomLine', 'Order', 'Job', 'Quote', 'Rfq', 'Source',
    'DocChunk', 'Fact', 'Conversation', 'ScheduleRun'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format(
      'create policy org_isolation on %I for all to authenticated
         using ("orgId" = public.current_org_id())
         with check ("orgId" = public.current_org_id())',
      t
    );
  end loop;
end $$;

-- Read-only role for the agent's query_data tool (whitelisted views only).
-- create role takumo_readonly nologin;
-- grant select on <views> to takumo_readonly;
