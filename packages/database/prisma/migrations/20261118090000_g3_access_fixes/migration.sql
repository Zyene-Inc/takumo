-- Knowledge Hub gate G3 (independent security review), access fixes.

-- G3-F1: the owner on record has the owner's access only while their role
-- still administers the shop, as the app's viewer already decides (security
-- audit L3). An owner whose WorkOS role was lowered, or who was removed and
-- invited back with a lesser role, kept every folder's full capabilities here,
-- confidential ones included, and could grant them on.
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
    p_user is not null and coalesce(p_role in ('owner', 'admin'), false) and exists (
      select 1 from "Org" o where o.id = p_org and o."ownerUserId" = p_user
    ),
    p_user is not null and coalesce(p_role in ('owner', 'admin'), false)
$$;


-- G3-F7: every folder marked confidential is a root: it never inherits from
-- the folders above it, even from another confidential folder (the nearest
-- confidential folder on the path, not the topmost, as the app assumes when
-- it moves, freezes and shows inheritance). Folders inside one still inherit
-- from it. A confidential folder that was set to inherit and then moved under
-- another confidential folder opened to that folder's people. This only ever
-- narrows access.
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
                    coalesce(max(ancestor_depth) filter (where ancestor_confidential), 1)) as root_depth,
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
                    coalesce(max(depth) filter (where confidential), 1)) as depth
    from chain
  )
  select g."principalType", g."principalId", bit_or(g.capabilities)::integer
  from chain c
  cross join root r
  join "AccessGrant" g on g."folderId" = c.id and g."orgId" = p_org
  where c.depth >= r.depth
  group by g."principalType", g."principalId"
$$;

