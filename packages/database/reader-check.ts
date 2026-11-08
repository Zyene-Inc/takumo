// What must be true of the database before Ask Takumo's SQL runs in it,
// checked by the reader itself at the start of every query (reader.ts). Each
// row is one problem; none means the database is set up as reviewed:
//
// - the hotfix migrations ran (marker in ask_private.trusted);
// - every relation in schema ask is a security-barrier view filtered by
//   ask_private.org_id(), and its definition is exactly the one recorded as
//   trusted (ask_private.record_trusted(), run by the migrations): a barrier
//   alone doesn't show the view filters every table by shop;
// - the reader can run only ask_private.org_id and ask_private.run, both
//   unchanged, and run is SECURITY INVOKER;
// - the reader has no elevated attributes, belongs to no other role, can't
//   read the signing secret, and can read no table outside ask (other than
//   the fingerprints) in a schema it can use;
// - the transaction is read-only.
//
// Runs with search_path = pg_catalog (set just before it), the same as
// record_trusted(), so the definitions come out the same way.

export const SECURITY_PROBLEMS_SQL = `
with
views as (
  select c.relname as name, c.relkind = 'v' as is_view,
         coalesce((select bool_or(o.option_name = 'security_barrier' and o.option_value in ('true', 'on', '1'))
                   from pg_options_to_table(c.reloptions) o), false) as barrier,
         case when c.relkind = 'v' then pg_get_viewdef(c.oid) end as definition,
         c.reloptions
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'ask'
),
functions as (
  select p.proname as name, p.prosecdef as definer, md5(pg_get_functiondef(p.oid)) as fingerprint
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'ask_private' and has_function_privilege(p.oid, 'execute')
),
trusted as (select kind, name, fingerprint from ask_private.trusted),
me as (select * from pg_roles where rolname = current_user)
select problem from (
  select 'marker: hotfix migrations not applied' as problem
  where not exists (select 1 from trusted where kind = 'marker' and name = 'ask_sql_isolation' and fingerprint = '2')
  union all
  select 'view ' || name || ': not a security-barrier view' from views where not (is_view and barrier)
  union all
  select 'view ' || name || ': not filtered by ask_private.org_id()' from views
  where is_view and position('ask_private.org_id()' in definition) = 0
  union all
  select 'view ' || v.name || ': not the trusted definition' from views v
  where not exists (
    select 1 from trusted t
    where t.kind = 'view' and t.name = v.name
      and t.fingerprint = md5(coalesce(array_to_string(v.reloptions, ','), '') || '|' || coalesce(v.definition, '')))
  union all
  select 'view ' || t.name || ': missing' from trusted t
  where t.kind = 'view' and not exists (select 1 from views v where v.name = t.name)
  union all
  select 'function ' || f.name || ': runnable by the reader but not trusted' from functions f
  where not exists (select 1 from trusted t where t.kind = 'function' and t.name = f.name and t.fingerprint = f.fingerprint)
  union all
  select 'function run: missing' where not exists (select 1 from functions where name = 'run')
  union all
  select 'function run: SECURITY DEFINER' from functions where name = 'run' and definer
  union all
  select 'reader: elevated attributes' from me
  where rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication
  union all
  select 'reader: member of another role'
  where exists (select 1 from pg_auth_members m join me on m.member = me.oid)
  union all
  select 'reader: can read the signing secret' where has_table_privilege('ask_private.secret', 'select')
  union all
  select 'reader: can read ' || n.nspname || '.' || c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'v', 'm', 'f', 'p')
    and n.nspname not in ('pg_catalog', 'information_schema', 'ask')
    and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'
    and not (n.nspname = 'ask_private' and c.relname = 'trusted')
    and has_schema_privilege(n.oid, 'usage')
    and has_table_privilege(c.oid, 'select')
  union all
  select 'transaction: not read-only' where current_setting('transaction_read_only') <> 'on'
) problems`;
