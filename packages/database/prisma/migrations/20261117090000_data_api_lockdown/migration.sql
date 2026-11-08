-- Supabase's Data API (PostgREST, and GraphQL if installed) answers requests
-- as the `anon` and `authenticated` roles. Takumo never uses it: the app
-- reaches the database through Prisma as its own role, and Storage only from
-- the server with the service-role key. What a new table grants those roles
-- depends on each project's default privileges, so it is set here instead:
-- no privilege on any of Takumo's tables, sequences or functions, now or for
-- tables created later, and no use of the library, ask or ask_private
-- schemas. Row-level security (org_isolation) stays as a second layer.
-- Nothing changes where the roles don't exist (local and CI databases).

do $$
declare
  r text;
  s text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      continue;
    end if;
    execute format('revoke all on all tables in schema public from %I', r);
    execute format('revoke all on all sequences in schema public from %I', r);
    execute format('revoke all on all functions in schema public from %I', r);
    execute format('alter default privileges in schema public revoke all on tables from %I', r);
    execute format('alter default privileges in schema public revoke all on sequences from %I', r);
    execute format('alter default privileges in schema public revoke all on functions from %I', r);
    foreach s in array array['library', 'ask', 'ask_private'] loop
      if exists (select 1 from pg_namespace where nspname = s) then
        execute format('revoke all on schema %I from %I', s, r);
        execute format('revoke all on all tables in schema %I from %I', s, r);
        execute format('revoke all on all functions in schema %I from %I', s, r);
      end if;
    end loop;
  end loop;
end $$;

-- Supabase adds this event-trigger helper to new projects; it can't do
-- anything when called directly, but nothing outside should be able to call
-- a SECURITY DEFINER function through the API.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public;
    if exists (select 1 from pg_roles where rolname = 'anon') then
      revoke execute on function public.rls_auto_enable() from anon;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      revoke execute on function public.rls_auto_enable() from authenticated;
    end if;
  end if;
end $$;

-- The row-level security policies' shop: a fixed search path.
alter function public.current_org_id() set search_path = pg_catalog;
