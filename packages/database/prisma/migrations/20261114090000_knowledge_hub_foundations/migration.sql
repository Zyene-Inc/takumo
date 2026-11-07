-- AlterTable
ALTER TABLE "Org" ADD COLUMN     "libraryStage" TEXT NOT NULL DEFAULT 'off',
ADD COLUMN     "ownerUserId" TEXT;

-- AlterTable
ALTER TABLE "Source" ADD COLUMN     "folderId" TEXT,
ADD COLUMN     "inheritAccess" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "Folder" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'normal',
    "systemKey" TEXT,
    "path" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "depth" INTEGER NOT NULL DEFAULT 1,
    "inheritAccess" BOOLEAN NOT NULL DEFAULT true,
    "confidential" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepartmentMember" (
    "orgId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "addedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepartmentMember_pkey" PRIMARY KEY ("departmentId","userId")
);

-- CreateTable
CREATE TABLE "AccessGrant" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "folderId" TEXT,
    "sourceId" TEXT,
    "principalType" TEXT NOT NULL,
    "principalId" TEXT NOT NULL DEFAULT '',
    "capabilities" INTEGER NOT NULL,
    "grantedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Folder_orgId_idx" ON "Folder"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Folder_orgId_parentId_name_key" ON "Folder"("orgId", "parentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Folder_orgId_systemKey_key" ON "Folder"("orgId", "systemKey");

-- CreateIndex
CREATE INDEX "Folder_path_idx" ON "Folder" USING GIN ("path");

-- CreateIndex
CREATE UNIQUE INDEX "Department_orgId_name_key" ON "Department"("orgId", "name");

-- CreateIndex
CREATE INDEX "DepartmentMember_orgId_userId_idx" ON "DepartmentMember"("orgId", "userId");

-- CreateIndex
CREATE INDEX "AccessGrant_orgId_principalType_principalId_idx" ON "AccessGrant"("orgId", "principalType", "principalId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessGrant_folderId_principalType_principalId_key" ON "AccessGrant"("folderId", "principalType", "principalId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessGrant_sourceId_principalType_principalId_key" ON "AccessGrant"("sourceId", "principalType", "principalId");

-- CreateIndex
CREATE INDEX "Source_orgId_folderId_idx" ON "Source"("orgId", "folderId");

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Folder"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentMember" ADD CONSTRAINT "DepartmentMember_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentMember" ADD CONSTRAINT "DepartmentMember_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Company Knowledge Hub foundations (hand-written below this line).
-- Additive only: new tables, two nullable/defaulted columns on Source, two on
-- Org. Nothing reads them yet, so existing behaviour is unchanged.
-- ---------------------------------------------------------------------------

-- Shapes the app must never get wrong.
alter table "Org" add constraint "Org_libraryStage_check"
  check ("libraryStage" in ('off', 'library', 'confidential'));
alter table "Folder" add constraint "Folder_name_check"
  check (char_length(btrim("name")) between 1 and 120);
alter table "Folder" add constraint "Folder_kind_check"
  check ("kind" in ('normal', 'system', 'virtual_rfq', 'virtual_po'));
alter table "Department" add constraint "Department_name_check"
  check (char_length(btrim("name")) between 1 and 80);
alter table "AccessGrant" add constraint "AccessGrant_target_check"
  check (num_nonnulls("folderId", "sourceId") = 1);
alter table "AccessGrant" add constraint "AccessGrant_principal_check"
  check (
    "principalType" in ('everyone', 'role', 'department', 'user')
    and ("principalType" = 'everyone') = ("principalId" = '')
  );
alter table "AccessGrant" add constraint "AccessGrant_capabilities_check"
  check ("capabilities" between 1 and 63);

-- Top-level folders have no parent, and NULLs never clash in a unique index.
create unique index "Folder_orgId_root_name_key"
  on "Folder" ("orgId", "name") where "parentId" is null;

create schema if not exists library;

-- A folder's path and depth come from its parent, every time it's written:
-- the app can't set them, a folder can't move under itself or into another
-- shop, and moving a folder rewrites the paths below it (folder_after_move).
create or replace function library.folder_before_write() returns trigger
language plpgsql set search_path = public as $$
declare
  parent record;
begin
  if tg_op = 'UPDATE' and new."orgId" <> old."orgId" then
    raise exception 'A folder cannot move to another shop';
  end if;
  if new."parentId" is null then
    new.path := array[new.id];
    new.depth := 1;
    return new;
  end if;
  -- FOR SHARE: two moves at once that would put A under B and B under A
  -- each wait for the other's row, so Postgres aborts one of them.
  select "orgId", path, depth into parent from "Folder"
  where id = new."parentId" for share;
  if not found then
    raise exception 'Parent folder % does not exist', new."parentId";
  end if;
  if parent."orgId" <> new."orgId" then
    raise exception 'A folder''s parent must be in the same shop';
  end if;
  if new.id = any(parent.path) then
    raise exception 'A folder cannot be moved inside itself';
  end if;
  if parent.depth >= 20 then
    raise exception 'Folders can be nested at most 20 deep';
  end if;
  new.path := parent.path || new.id;
  new.depth := parent.depth + 1;
  return new;
end $$;

create trigger folder_before_write
  before insert or update on "Folder"
  for each row execute function library.folder_before_write();

create or replace function library.folder_after_move() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.path is distinct from old.path then
    -- Touching each child re-runs folder_before_write, which rebuilds its
    -- path from this one; its own after-trigger carries on downwards.
    update "Folder" set "parentId" = "parentId" where "parentId" = new.id;
  end if;
  return null;
end $$;

create trigger folder_after_move
  after update on "Folder"
  for each row execute function library.folder_after_move();

-- Rows that point at a folder, document or department must be in its shop.
create or replace function library.same_shop_check() returns trigger
language plpgsql set search_path = public as $$
declare
  other text;
begin
  if tg_table_name = 'Source' then
    if new."folderId" is not null then
      select "orgId" into other from "Folder" where id = new."folderId";
      if other is distinct from new."orgId" then
        raise exception 'A document''s folder must be in the same shop';
      end if;
    end if;
  elsif tg_table_name = 'DepartmentMember' then
    select "orgId" into other from "Department" where id = new."departmentId";
    if other is distinct from new."orgId" then
      raise exception 'A department member must be in the department''s shop';
    end if;
  elsif tg_table_name = 'AccessGrant' then
    if new."folderId" is not null then
      select "orgId" into other from "Folder" where id = new."folderId";
    else
      select "orgId" into other from "Source" where id = new."sourceId";
    end if;
    if other is distinct from new."orgId" then
      raise exception 'A grant must be in the same shop as its folder or document';
    end if;
    if new."principalType" = 'department' then
      select "orgId" into other from "Department" where id = new."principalId";
      if other is distinct from new."orgId" then
        raise exception 'A department grant must name a department of the same shop';
      end if;
    end if;
  end if;
  return new;
end $$;

create trigger source_same_shop
  before insert or update of "folderId", "orgId" on "Source"
  for each row execute function library.same_shop_check();
create trigger department_member_same_shop
  before insert or update on "DepartmentMember"
  for each row execute function library.same_shop_check();
create trigger access_grant_same_shop
  before insert or update on "AccessGrant"
  for each row execute function library.same_shop_check();

-- A deleted department's grants go with it (they name it only by ID).
create or replace function library.department_after_delete() returns trigger
language plpgsql set search_path = public as $$
begin
  delete from "AccessGrant"
  where "orgId" = old."orgId" and "principalType" = 'department'
    and "principalId" = old.id;
  return null;
end $$;

create trigger department_after_delete
  after delete on "Department"
  for each row execute function library.department_after_delete();

-- ---------------------------------------------------------------------------
-- Who may do what. These functions are the only place access is decided.
-- The app passes three facts it has verified with WorkOS on this request:
-- the shop, the user and their role in it (both null for background work).
-- Everything else is worked out here from the database, never taken from
-- the caller: departments (DepartmentMember), ownership (Org.ownerUserId),
-- admin (the role). A user without a role is not a member and gets nothing.
-- Capability bits: 1 view, 2 download, 4 upload, 8 edit, 16 delete,
-- 32 manage (63 = all).
--
-- Inheritance: a folder's grants apply to everything below it, up to the
-- nearest folder (or the item itself) that stops inheriting. Grants only add.
-- The owner may do everything. Admins may do everything outside confidential
-- folders, and inside them only what they are granted.
-- ---------------------------------------------------------------------------

create or replace function library.principal_key(p_type text, p_id text)
returns text language sql immutable as $$
  select case when p_type = 'everyone' then 'everyone' else p_type || ':' || p_id end
$$;

-- In a confidential folder, a grant to everyone or to a whole role allows
-- uploading at most, whatever it says: enforced here as well as when grants
-- are written, so a grant inherited from above can't open HR up.
create or replace function library.allowed(p_caps integer, p_type text, p_confidential boolean)
returns integer language sql immutable as $$
  select case when p_confidential and p_type in ('everyone', 'role') then p_caps & 4 else p_caps end
$$;

-- What the principals were granted on each folder of the shop, before the
-- owner/admin rules, and whether the folder is (inside) a confidential one.
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
           coalesce(max(ancestor_depth) filter (where not ancestor_inherit), 1) as root_depth,
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

-- Who the person is to the grants, from the database: 'everyone',
-- 'role:<slug>', 'department:<id>' for each department they're in here, and
-- 'user:<id>'; whether they own the shop; whether their role administers it.
-- Background work (no user, no role) is 'everyone' only. A user without a
-- role, or a role without a user, matches nothing.
create or replace function library.who(p_org text, p_user text, p_role text)
returns table (principals text[], is_owner boolean, is_admin boolean)
language sql stable set search_path = public as $$
  select
    case
      when p_user is null and p_role is null then array['everyone']
      when p_user is null or p_role is null then array[]::text[]
      else array['everyone', 'role:' || p_role, 'user:' || p_user]
        || coalesce(
          (select array_agg('department:' || dm."departmentId")
           from "DepartmentMember" dm
           where dm."orgId" = p_org and dm."userId" = p_user),
          array[]::text[])
    end,
    p_user is not null and p_role is not null and exists (
      select 1 from "Org" o where o.id = p_org and o."ownerUserId" = p_user
    ),
    p_user is not null and coalesce(p_role in ('owner', 'admin'), false)
$$;

create or replace function library.folder_access(p_org text, p_user text, p_role text)
returns table (folder_id text, capabilities integer, confidential boolean)
language sql stable set search_path = public as $$
  select fg.folder_id,
         case when w.is_owner then 63
              when w.is_admin and not fg.confidential then 63
              else fg.capabilities end,
         fg.confidential
  from library.who(p_org, p_user, p_role) w
  cross join lateral library.folder_grants(p_org, w.principals) fg
$$;

-- Uploaded documents only. A document outside any folder (all documents
-- stored before folders) can be read and downloaded by everyone in the shop,
-- as today, unless it stops inheriting. Called through source_access.
create or replace function library.document_grants(
  p_org text, p_principals text[], p_owner boolean, p_admin boolean
)
returns table (source_id text, capabilities integer, confidential boolean)
language sql stable set search_path = public as $$
  with folders as (select * from library.folder_grants(p_org, p_principals)),
  docs as (
    select s.id, s."folderId", s."inheritAccess",
           coalesce(fg.confidential, false) as confidential,
           coalesce(fg.capabilities, 0) as folder_caps
    from "Source" s
    left join folders fg on fg.folder_id = s."folderId"
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
         case when p_owner then 63
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

create or replace function library.source_access(p_org text, p_user text, p_role text)
returns table (source_id text, capabilities integer, confidential boolean)
language sql stable set search_path = public as $$
  select d.source_id, d.capabilities, d.confidential
  from library.who(p_org, p_user, p_role) w
  cross join lateral library.document_grants(p_org, w.principals, w.is_owner, w.is_admin) d
$$;

-- Every grant that applies inside a folder through inheritance (its own and
-- those above it, up to where inheritance stops), one row per principal.
-- Copied onto an item when it stops inheriting, so nobody loses access
-- silently; removing them afterwards is a separate, deliberate step.
create or replace function library.chain_grants(p_org text, p_folder text)
returns table (principal_type text, principal_id text, capabilities integer)
language sql stable set search_path = public as $$
  with target as (
    select path from "Folder" where id = p_folder and "orgId" = p_org
  ),
  chain as (
    select a.id, a.depth, a."inheritAccess" as inherit
    from "Folder" a, target t
    where a.id = any (t.path) and a."orgId" = p_org
  ),
  root as (
    select coalesce(max(depth) filter (where not inherit), 1) as depth from chain
  )
  select g."principalType", g."principalId", bit_or(g.capabilities)::integer
  from chain c
  cross join root r
  join "AccessGrant" g on g."folderId" = c.id and g."orgId" = p_org
  where c.depth >= r.depth
  group by g."principalType", g."principalId"
$$;

create or replace function library.visible_source_ids(p_org text, p_user text, p_role text)
returns setof text language sql stable set search_path = public as $$
  select source_id from library.source_access(p_org, p_user, p_role)
  where capabilities & 1 = 1
$$;

-- Only the login that owns this schema (the one running migrations, which
-- the app also uses) may call these: a new schema gives PUBLIC no USAGE, so
-- the Ask Takumo reader and Supabase's API roles (anon, authenticated) can't.
-- `pnpm --filter @repo/database check:db-access` confirms the app's login can.
revoke execute on all functions in schema library from public;

-- Tenant data: same row-level security backstop as the other tables.
do $$
declare
  grantee text := case
    when exists (select 1 from pg_roles where rolname = 'authenticated') then 'authenticated'
    else 'public'
  end;
  t text;
begin
  foreach t in array array['Folder', 'Department', 'DepartmentMember', 'AccessGrant'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format(
      'create policy org_isolation on %I for all to %s using ("orgId" = public.current_org_id()) with check ("orgId" = public.current_org_id())',
      t, grantee
    );
  end loop;
end $$;

-- Ownership for existing shops: the creator was recorded as the one "owner"
-- Member row. Shops with none or several stay without an owner until it is
-- set by hand (the Member copy can be stale, so nothing else is trusted).
update "Org" o
set "ownerUserId" = m."userId"
from (
  select "orgId", min("userId") as "userId"
  from "Member"
  where role = 'owner'
  group by "orgId"
  having count(*) = 1
) m
where m."orgId" = o.id and o."ownerUserId" is null;

