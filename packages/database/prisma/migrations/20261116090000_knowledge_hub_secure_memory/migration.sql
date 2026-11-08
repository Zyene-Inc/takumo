-- Company Knowledge Hub, phase 4: folder AI settings, facts published to the
-- company on purpose, and the functions every AI path uses to decide which
-- documents and facts a person may give to Ask. Adds columns and functions
-- only. Existing folders get AI "full" (as today) and no fact is published,
-- so nobody's access widens; restricted access stays switched off in code
-- (CONFIDENTIAL_READY in apps/app/lib/library/stage.ts).

-- AlterTable
ALTER TABLE "Fact" ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "publishedBy" TEXT;

-- AlterTable
ALTER TABLE "Folder" ADD COLUMN     "aiMode" TEXT NOT NULL DEFAULT 'full';

-- ---------------------------------------------------------------------------
-- Hand-written below this line.
-- ---------------------------------------------------------------------------

alter table "Folder" add constraint "Folder_aiMode_check"
  check ("aiMode" in ('off', 'search', 'full'));

-- A published fact says who published it.
alter table "Fact" add constraint "Fact_published_check"
  check (("publishedAt" is null) = ("publishedBy" is null));

-- A confidential folder never inherits access from the folders above it
-- (security audit H1): the topmost confidential folder on a path is a root,
-- as is any folder that stops inheriting. Otherwise whoever manages the
-- folder above (any admin) could give themselves, or a department they
-- belong to, access to everything inside, and admins have no automatic
-- access to confidential folders.
create or replace function library.folder_grants(p_org text, p_principals text[])
returns table (folder_id text, capabilities integer, confidential boolean)
language sql stable set search_path = public as $$
  with f as (
    select id, path, depth, "inheritAccess" as inherit, confidential
    from "Folder" where "orgId" = p_org
  ),
  chain as (
    select f.id, a.id as ancestor, a.depth as ancestor_depth,
           a.inherit as ancestor_inherit, a.confidential as ancestor_confidential
    from f join f a on a.id = any (f.path)
  ),
  roots as (
    select id,
           greatest(coalesce(max(ancestor_depth) filter (where not ancestor_inherit), 1),
                    coalesce(min(ancestor_depth) filter (where ancestor_confidential), 1)) as root_depth,
           bool_or(ancestor_confidential) as confidential
    from chain group by id
  ),
  granted as (
    select c.id, coalesce(bit_or(library.allowed(g.capabilities, g."principalType", r.confidential)), 0) as caps
    from chain c
    join roots r on r.id = c.id and c.ancestor_depth >= r.root_depth
    left join "AccessGrant" g
      on g."folderId" = c.ancestor and g."orgId" = p_org
     and library.principal_key(g."principalType", g."principalId") = any (p_principals)
    group by c.id
  )
  select r.id, g.caps, r.confidential
  from roots r join granted g on g.id = r.id
$$;

-- What an item inherits with p_folder above it: the same roots as folder_grants.
create or replace function library.chain_grants(p_org text, p_folder text)
returns table (principal_type text, principal_id text, capabilities integer)
language sql stable set search_path = public as $$
  with target as (
    select path from "Folder" where id = p_folder and "orgId" = p_org
  ),
  chain as (
    select a.id, a.depth, a."inheritAccess" as inherit, a.confidential
    from "Folder" a, target t
    where a.id = any (t.path) and a."orgId" = p_org
  ),
  root as (
    select greatest(coalesce(max(depth) filter (where not inherit), 1),
                    coalesce(min(depth) filter (where confidential), 1)) as depth
    from chain
  )
  select g."principalType", g."principalId", bit_or(g.capabilities)::integer
  from chain c
  cross join root r
  join "AccessGrant" g on g."folderId" = c.id and g."orgId" = p_org
  where c.depth >= r.depth
  group by g."principalType", g."principalId"
$$;

-- A row never moves to another shop (security audit L11): the same-shop
-- triggers check new rows and new links, and nothing in the app changes a
-- shop, so changing "orgId" is refused outright on everything access and AI
-- answers are built from.
create or replace function library.org_unchanged() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  if new."orgId" is distinct from old."orgId" then
    raise exception '% rows can''t move to another shop', tg_table_name;
  end if;
  return new;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['Folder', 'Source', 'AccessGrant', 'Department', 'DepartmentMember',
                           'Fact', 'FactSource', 'DocumentVersion', 'DocumentPage', 'DocChunk',
                           'MessageSource'] loop
    execute format(
      'create trigger %I before update of "orgId" on %I for each row execute function library.org_unchanged()',
      lower(t) || '_org_unchanged', t);
  end loop;
end $$;

-- off < search < full. Anything else counts as off.
create or replace function library.mode_rank(p_mode text)
returns integer language sql immutable as $$
  select case p_mode when 'full' then 2 when 'search' then 1 else 0 end
$$;

-- Each folder's AI setting in force: the most restrictive one on its path,
-- so a folder inside HR can't send more to outside AI services than HR.
create or replace function library.folder_ai_modes(p_org text)
returns table (folder_id text, ai_mode text)
language sql stable set search_path = public as $$
  select f.id,
         (array['off', 'search', 'full'])[min(library.mode_rank(a."aiMode")) + 1]
  from "Folder" f
  join "Folder" a on a.id = any (f.path) and a."orgId" = p_org
  where f."orgId" = p_org
  group by f.id
$$;

-- Each uploaded document's AI setting: its folder's; "full" outside any
-- folder (every document stored before folders, as before).
create or replace function library.document_ai_modes(p_org text)
returns table (source_id text, ai_mode text)
language sql stable set search_path = public as $$
  select s.id, coalesce(m.ai_mode, case when s."folderId" is null then 'full' else 'off' end)
  from "Source" s
  left join library.folder_ai_modes(p_org) m on m.folder_id = s."folderId"
  where s."orgId" = p_org and s.type = 'upload' and s.profile = 'document'
$$;

-- The documents whose text this person's questions may draw on: they may
-- view it, it isn't in the Trash, it has a version in use, and its AI
-- setting allows at least p_min ('search': keyword passages; 'full': also
-- vectors and facts). Everything Ask, the Brain and facts read goes
-- through this, inside the query, so nothing else reaches the model.
create or replace function library.ai_source_ids(p_org text, p_user text, p_role text, p_min text)
returns setof text
language plpgsql stable set search_path = public as $$
begin
  if p_min is null or p_min not in ('search', 'full') then
    raise exception 'ai_source_ids needs ''search'' or ''full''';
  end if;
  return query
    select a.source_id
    from library.source_access(p_org, p_user, p_role) a
    join "Source" s on s.id = a.source_id and s."orgId" = p_org
    join library.document_ai_modes(p_org) m on m.source_id = a.source_id
    where a.capabilities & 1 = 1
      and s."deletedAt" is null
      and s."currentVersionId" is not null
      and library.mode_rank(m.ai_mode) >= library.mode_rank(p_min);
end $$;

-- The facts this person may see, and whether its words from documents
-- (Fact.evidence, FactSource.quote) may be shown to them.
--
--   published on purpose        everyone; quotes only as below
--   provenance 'none'           everyone (typed, spoken or measured)
--   provenance 'documents'      whoever may use EVERY document it came from
--                               (live, viewable, AI 'full'); one in the Trash
--                               or out of reach hides it, from the owner too
--   provenance 'unknown'        older facts and facts from conversations that
--                               couldn't be traced: everyone while the shop
--                               restricts nothing (every document was
--                               company-wide), else the owner only until
--                               someone publishes them
--   provenance 'source_deleted' a document it came from was deleted for
--                               good: the owner only, until published
--
-- Never inferred from missing rows: 'documents' with no document listed is
-- seen by nobody.
create or replace function library.fact_access(p_org text, p_user text, p_role text)
returns table (fact_id text, evidence boolean)
language sql stable set search_path = public as $$
  with w as (
    select * from library.who(p_org, p_user, p_role)
  ),
  shop as (
    select "libraryStage" = 'confidential' as restricting from "Org" where id = p_org
  ),
  usable as (
    select id from library.ai_source_ids(p_org, p_user, p_role, 'full') as id
  ),
  facts as (
    select f.id, f.provenance, f."publishedAt" is not null as published,
           count(fs."sourceId") as sources,
           count(fs."sourceId") filter (where fs."sourceId" in (select id from usable)) as usable_sources
    from "Fact" f
    left join "FactSource" fs on fs."factId" = f.id and fs."orgId" = p_org
    where f."orgId" = p_org
    group by f.id
  ),
  judged as (
    select f.id, f.published,
           case f.provenance
             when 'none' then true
             when 'documents' then f.sources > 0 and f.usable_sources = f.sources
             when 'unknown' then (not s.restricting or w.is_owner) and f.usable_sources = f.sources
             when 'source_deleted' then w.is_owner
             else false
           end as own_right,
           -- Words quoted from documents (Fact.evidence, FactSource.quote) only
           -- when this person may use every document attached, whatever the
           -- fact's provenance: a fact typed by a person can still carry a
           -- quote from a restricted document.
           f.usable_sources = f.sources as sources_usable
    from facts f cross join w cross join shop s
    where cardinality(w.principals) > 0
  )
  select id, own_right and sources_usable from judged where published or own_right
$$;

revoke execute on all functions in schema library from public;

-- ---------------------------------------------------------------------------
-- Ask Takumo's SQL reader (query_data) sees only what every member of the
-- shop may: published facts, facts nobody's documents restrict, and the
-- words from documents only when every one of them is company-wide. It can't
-- tell who is asking, so restricted facts are reached only through tools
-- that check the person (get_record).
--
-- The SQL tool's security check (packages/database/reader-check.ts, Ask SQL
-- hotfix 20261113110000) keeps query_data off unless every ask view is a
-- security barrier filtered by ask_private.org_id(), exactly as recorded in
-- ask_private.trusted, and the reader can run only trusted functions. A view's
-- user needs EXECUTE on the functions it calls, so the reader runs
-- company_facts(): SECURITY DEFINER, no arguments, fixed to the signed shop,
-- and never callable from the agent's SQL (sql-allow.ts doesn't list it).
-- ---------------------------------------------------------------------------

create or replace function ask_private.company_facts()
returns table (fact_id text, evidence boolean)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select a.fact_id, a.evidence
  from library.fact_access((select ask_private.org_id()), null, null) a
$$;

revoke all on function ask_private.company_facts() from public;

-- pgcrypto's hmac comes from "extensions" (Supabase) before anything in public.
alter function ask_private.org_id() set search_path = pg_catalog, extensions, public, pg_temp;

create or replace view ask.facts with (security_barrier = true) as
  select 'F-' || f.number as fact_no, f."subjectType" as subject_type,
         f."subjectLabel" as subject, f.attribute,
         f.value #>> '{}' as value, f."previousValue" #>> '{}' as previous_value,
         f.status::text as status, f.source,
         case when c.evidence then f.evidence end as evidence,
         f."createdAt"::date as stated_on, f."reviewedAt"::date as reviewed_on,
         f."validTo"::date as valid_to
  from "Fact" f
  join ask_private.company_facts() c on c.fact_id = f.id
  where f."orgId" = (select ask_private.org_id());

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'takumo_reader') then
    grant execute on function ask_private.company_facts() to takumo_reader;
    grant select on ask.facts to takumo_reader;
  end if;
end $$;

-- company_facts joins the functions the reader may run (org_id, run), then
-- every view and function is fingerprinted again, as reviewed here.
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
  where n.nspname = 'ask_private' and p.proname in ('org_id', 'run', 'company_facts');
  insert into ask_private.trusted (kind, name, fingerprint)
  values ('marker', 'ask_sql_isolation', '2')
  on conflict (kind, name) do update set fingerprint = excluded.fingerprint;
end $$;

revoke all on function ask_private.record_trusted() from public;

select ask_private.record_trusted();
