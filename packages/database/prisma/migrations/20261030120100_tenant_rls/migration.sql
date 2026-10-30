-- Row-level security as a backstop for tenant isolation, plus the vector index.
-- The app itself scopes every query by orgId (forOrg); these policies protect
-- data if anything ever connects as Supabase's `authenticated` role.
--
-- WorkOS is connected to Supabase as a third-party auth provider, so the
-- WorkOS access token's claims are in request.jwt.claims; `org_id` is the
-- active organization. Safe to run more than once, and on plain Postgres
-- (tests), where the policies apply to PUBLIC instead.

create extension if not exists vector;

create index if not exists doc_chunk_embedding_idx
  on "DocChunk" using hnsw (embedding vector_cosine_ops);

create or replace function public.current_org_id() returns text
  language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'org_id'
$$;

do $$
declare
  t text;
  grantee text := case
    when exists (select 1 from pg_roles where rolname = 'authenticated')
      then 'authenticated'
    else 'public'
  end;
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
      'create policy org_isolation on %I for all to %s
         using ("orgId" = public.current_org_id())
         with check ("orgId" = public.current_org_id())',
      t, grantee
    );
  end loop;
end $$;
