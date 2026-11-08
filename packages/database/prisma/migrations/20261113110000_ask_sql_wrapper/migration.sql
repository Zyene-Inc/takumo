-- Security hotfix, part 2: other shops can't read the agent's SQL, and the app
-- can tell that the database is set up as reviewed before it runs any.
--
-- 1. ask_private.run(statement, row_limit): the agent's SELECT arrives as a
--    bind parameter and runs inside this function with one dynamic EXECUTE.
--    Every shop's queries use the one takumo_reader login, and a session can
--    read the statement text of its login's other sessions in
--    pg_stat_activity; that text is now always
--    "select r from ask_private.run($1, $2) as r", never the agent's SQL
--    (parameter values aren't shown there). Turning off track_activities
--    would do the same, but on Supabase the migration's role can't
--    (migration 20261113100000_ask_view_isolation tries).
--    SECURITY INVOKER: it runs with the reader's own rights, nothing more,
--    only in a read-only transaction and only with a signed shop.
-- 2. ask_private.trusted: fingerprints of the ask views and of
--    ask_private.org_id/run as reviewed, recorded by ask_private.record_trusted()
--    (owner only). Before each query the app compares what's installed with
--    them (packages/database/reader.ts) and refuses to run on any difference.
--    A later migration that changes an ask view or one of these functions on
--    purpose must keep the views security barriers filtered by
--    ask_private.org_id(), then call ask_private.record_trusted();
--    record_trusted() refuses a view that isn't.

create or replace function ask_private.run(statement text, row_limit integer)
returns setof json
language plpgsql
volatile
security invoker
set search_path = pg_catalog, ask, pg_temp
as $$
begin
  if current_setting('transaction_read_only') <> 'on' then
    raise exception 'ask_private.run runs only in a read-only transaction'
      using errcode = '25006';
  end if;
  if ask_private.org_id() is null then
    raise exception 'ask_private.run needs a signed shop' using errcode = '42501';
  end if;
  if row_limit is null or row_limit < 1 or row_limit > 1000 then
    raise exception 'ask_private.run: row_limit must be 1 to 1000' using errcode = '22023';
  end if;
  -- The newline ends a trailing -- comment in the statement.
  return query execute
    'select row_to_json(answer) from (' || statement || E'\n) as answer limit '
    || row_limit::text;
end $$;

revoke all on function ask_private.run(text, integer) from public;

create table if not exists ask_private.trusted (
  kind text not null,
  name text not null,
  fingerprint text not null,
  primary key (kind, name)
);
revoke all on ask_private.trusted from public;

-- What's installed now, as fingerprints: each ask view (options and
-- definition) and the two ask_private functions the reader may run. Always
-- computed with search_path = pg_catalog, so names come out fully qualified
-- the same way here and in the app's check.
create or replace function ask_private.record_trusted()
returns void
language plpgsql
security invoker
set search_path = pg_catalog
as $$
declare
  bad text;
begin
  select string_agg(c.relname, ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'ask'
    and not (
      c.relkind = 'v'
      and coalesce((select bool_or(o.option_name = 'security_barrier' and o.option_value in ('true', 'on', '1'))
                    from pg_options_to_table(c.reloptions) o), false)
      and position('ask_private.org_id()' in pg_get_viewdef(c.oid)) > 0
    );
  if bad is not null then
    raise exception 'ask views must be security barriers filtered by ask_private.org_id(): %', bad;
  end if;
  delete from ask_private.trusted where kind in ('view', 'function');
  insert into ask_private.trusted (kind, name, fingerprint)
  select 'view', c.relname,
         md5(coalesce(array_to_string(c.reloptions, ','), '') || '|' || pg_get_viewdef(c.oid))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'ask' and c.relkind = 'v';
  insert into ask_private.trusted (kind, name, fingerprint)
  select 'function', p.proname, md5(pg_get_functiondef(p.oid))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'ask_private' and p.proname in ('org_id', 'run');
  insert into ask_private.trusted (kind, name, fingerprint)
  values ('marker', 'ask_sql_isolation', '2')
  on conflict (kind, name) do update set fingerprint = excluded.fingerprint;
end $$;

revoke all on function ask_private.record_trusted() from public;

select ask_private.record_trusted();

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'takumo_reader') then
    grant execute on function ask_private.run(text, integer) to takumo_reader;
    -- Fingerprints only: what the app's check compares with.
    grant select on ask_private.trusted to takumo_reader;
  end if;
end $$;
