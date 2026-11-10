-- Personal and Public folders, and the library on for every shop.
--
-- Personal: each member gets one folder only they can open. Nobody else
-- reaches it or anything under it: not the shop's owner, not admins, not a
-- grant. library.folder_access and library.document_grants give it all
-- capabilities for its person and none for anyone else, ahead of every other
-- rule, so pages, downloads, search, Ask Takumo, facts and the Brain (which
-- all start from these functions) follow it.
--
-- Public: the default "General" folder is renamed Public, and documents
-- outside any folder move into it.

-- ---------------------------------------------------------------------------
-- Personal folders

alter table "Folder" add column "personalUserId" text;
-- Set when the person leaves the shop; the folder is deleted for good after.
alter table "Folder" add column "deleteAfter" timestamp(3);

alter table "Folder" drop constraint "Folder_kind_check";
alter table "Folder" add constraint "Folder_kind_check"
  check ("kind" in ('normal', 'system', 'personal', 'virtual_rfq', 'virtual_po'));
-- A personal folder names its person, sits at the top, and nothing else does.
alter table "Folder" add constraint "Folder_personal_check"
  check ((kind = 'personal') = ("personalUserId" is not null));
alter table "Folder" add constraint "Folder_personal_top_check"
  check (kind <> 'personal' or "parentId" is null);
alter table "Folder" add constraint "Folder_personal_flags_check"
  check (kind <> 'personal' or (not confidential and "inheritAccess"));

create unique index "Folder_orgId_personalUserId_key"
  on "Folder" ("orgId", "personalUserId") where "personalUserId" is not null;

-- Every member's folder is called "Personal": top-level names stay unique
-- among the folders people share.
drop index "Folder_orgId_root_name_key";
create unique index "Folder_orgId_root_name_key"
  on "Folder" ("orgId", "name") where "parentId" is null and kind <> 'personal';

-- Every folder inside a personal folder (and the folder itself), with whose
-- it is.
create or replace function library.personal_folders(p_org text)
returns table (folder_id text, personal_user text)
language sql stable set search_path = public as $$
  select f.id, p."personalUserId"
  from "Folder" f
  join "Folder" p
    on p.id = any (f.path) and p."orgId" = p_org and p."personalUserId" is not null
  where f."orgId" = p_org
$$;

-- As before, with personal folders first: their person may do everything,
-- everyone else nothing.
create or replace function library.folder_access(p_org text, p_user text, p_role text)
returns table (folder_id text, capabilities integer, confidential boolean)
language sql stable set search_path = public as $$
  select fg.folder_id,
         case when pf.personal_user is not null then
                case when ('user:' || pf.personal_user) = any (w.principals) then 63 else 0 end
              when w.is_owner then 63
              when w.is_admin and not fg.confidential then 63
              else fg.capabilities end,
         fg.confidential
  from library.who(p_org, p_user, p_role) w
  cross join lateral library.folder_grants(p_org, w.principals) fg
  left join library.personal_folders(p_org) pf on pf.folder_id = fg.folder_id
$$;

create or replace function library.document_grants(
  p_org text, p_principals text[], p_owner boolean, p_admin boolean
)
returns table (source_id text, capabilities integer, confidential boolean)
language sql stable set search_path = public as $$
  with folders as (select * from library.folder_grants(p_org, p_principals)),
  docs as (
    select s.id, s."folderId", s."inheritAccess",
           coalesce(fg.confidential, false) as confidential,
           coalesce(fg.capabilities, 0) as folder_caps,
           pf.personal_user
    from "Source" s
    left join folders fg on fg.folder_id = s."folderId"
    left join library.personal_folders(p_org) pf on pf.folder_id = s."folderId"
    where s."orgId" = p_org and s.type = 'upload' and s.profile = 'document'
  ),
  own as (
    select d.id, bit_or(library.allowed(g.capabilities, g."principalType", d.confidential)) as caps
    from docs d
    join "AccessGrant" g on g."sourceId" = d.id and g."orgId" = p_org
    where library.principal_key(g."principalType", g."principalId") = any (p_principals)
    group by d.id
  )
  select d.id,
         case when d.personal_user is not null then
                case when ('user:' || d.personal_user) = any (p_principals) then 63 else 0 end
              when p_owner then 63
              when p_admin and not d.confidential then 63
              else coalesce(o.caps, 0)
                 | case when not d."inheritAccess" then 0
                        when d."folderId" is null then
                          case when 'everyone' = any (p_principals) then 3 else 0 end
                        else d.folder_caps end
         end,
         d.confidential
  from docs d
  left join own o on o.id = d.id
$$;

-- Same as the other library functions (data_api_lockdown): nothing outside
-- the app's own login may call it.
do $$
declare
  r text;
begin
  revoke all on function library.personal_folders(text) from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function library.personal_folders(text) from %I', r);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The library for every shop

alter table "Org" alter column "libraryStage" set default 'library';
update "Org" set "libraryStage" = 'library' where "libraryStage" = 'off';

-- ---------------------------------------------------------------------------
-- Public

-- The default General folder becomes Public, but only where it really is
-- open to everyone: not confidential, with an "everyone may view" grant.
-- A General the shop restricted keeps its name (a folder called Public that
-- only some people can open would mislead), and the shop gets its own Public
-- below. Nor where a top-level folder is already called Public.
update "Folder" g
set name = 'Public', "systemKey" = 'public', "updatedAt" = now()
where g."systemKey" = 'general'
  and not g.confidential
  and g."inheritAccess"
  and exists (
    select 1 from "AccessGrant" a
    where a."folderId" = g.id and a."principalType" = 'everyone'
      and a.capabilities & 1 = 1
  )
  and not exists (
    select 1 from "Folder" o
    where o."orgId" = g."orgId" and o."parentId" is null
      and o.name = 'Public' and o.id <> g.id
  );

-- Shops without one get a Public folder everyone may view, download and add
-- to (the grant every default folder starts with). An existing folder keeps
-- the access the shop gave it.
with made as (
  insert into "Folder" (id, "orgId", name, kind, "systemKey", "updatedAt")
  select gen_random_uuid()::text, o.id, 'Public', 'system', 'public', now()
  from "Org" o
  where not exists (
      select 1 from "Folder" f where f."orgId" = o.id and f."systemKey" = 'public'
    )
    and not exists (
      select 1 from "Folder" f
      where f."orgId" = o.id and f."parentId" is null and f.name = 'Public'
    )
  returning id, "orgId"
)
insert into "AccessGrant" (id, "orgId", "folderId", "principalType", "principalId", capabilities)
select gen_random_uuid()::text, m."orgId", m.id, 'everyone', '', 7
from made m;

-- Documents outside any folder move into Public, unless the shop made it
-- confidential (fewer people would see them) or a live document there has
-- the same name (it stays where it is). Documents in the Trash move too, so
-- restoring one puts it in Public.
update "Source" s
set "folderId" = p.id
from "Folder" p
where p."orgId" = s."orgId" and p."systemKey" = 'public' and not p.confidential
  and s."folderId" is null and s.type = 'upload' and s.profile = 'document'
  and (
    s."deletedAt" is not null
    or not exists (
      select 1 from "Source" c
      where c."orgId" = s."orgId" and c."folderId" = p.id and c.name = s.name
        and c.type = 'upload' and c.profile = 'document' and c."deletedAt" is null
    )
  );
