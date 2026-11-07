import "server-only";

import { database, forOrg } from "@repo/database";
import { type Access, requireCapability, type Target } from "./access";
import {
  CAPABILITY,
  capabilitiesProblem,
  combine,
  covers,
  PRESETS,
} from "./capabilities";
import { confidentialEnabled, NOT_YET } from "./stage";
import { trustedViewer, type Viewer } from "./viewer";

// Changing who may do what with a folder or document. Every change needs
// "manage" on it, gives at most what the changer holds (the owner excepted),
// and is refused while restricted access is switched off (stage.ts).

export type Principal =
  | { type: "everyone" }
  | { type: "role" | "department" | "user"; id: string };

type Result = { ok: true } | { ok: false; error: string };

const NOT_FOUND = "That folder or document isn't there any more.";
const NOT_MANAGER = "Only someone who manages it can change who has access.";

/** The viewer may change access to `target`: its access, or why not. */
const managing = async (
  viewer: Viewer,
  target: Target
): Promise<{ ok: true; access: Access } | { ok: false; error: string }> => {
  if (trustedViewer(viewer).isSystem) {
    return { ok: false, error: NOT_MANAGER };
  }
  if (!(await confidentialEnabled(viewer.orgId))) {
    return { ok: false, error: NOT_YET };
  }
  const check = await requireCapability(viewer, target, "manage");
  if (!check.ok) {
    return {
      ok: false,
      error: check.reason === "not_found" ? NOT_FOUND : NOT_MANAGER,
    };
  }
  return check;
};

/** Why this grant can't be made, or null. Pure, so tested. */
export const grantProblem = ({
  viewer,
  access,
  principal,
  capabilities,
}: {
  access: Access;
  capabilities: number;
  principal: Principal;
  viewer: Pick<Viewer, "isOwner">;
}) => {
  const shape = capabilitiesProblem(capabilities);
  if (shape) {
    return shape;
  }
  if (!(viewer.isOwner || covers(access.capabilities, capabilities))) {
    return "You can only give access you have yourself.";
  }
  const wholeGroup = principal.type === "everyone" || principal.type === "role";
  if (access.confidential && wholeGroup && capabilities !== CAPABILITY.upload) {
    return "In a confidential folder, everyone or a whole role may only upload. Give access to a department or a person instead.";
  }
  return null;
};

const principalId = (principal: Principal) =>
  principal.type === "everyone" ? "" : principal.id;

const targetWhere = (target: Target, principal: Principal) => {
  const key = {
    principalType: principal.type,
    principalId: principalId(principal),
  };
  return "folderId" in target
    ? {
        folderId_principalType_principalId: {
          folderId: target.folderId,
          ...key,
        },
      }
    : {
        sourceId_principalType_principalId: {
          sourceId: target.sourceId,
          ...key,
        },
      };
};

/** Give (or change) what `principal` may do with a folder or document. */
export const grantAccess = async (
  viewer: Viewer,
  target: Target,
  principal: Principal,
  capabilities: number
): Promise<Result> => {
  const check = await managing(viewer, target);
  if (!check.ok) {
    return check;
  }
  const problem = grantProblem({
    viewer,
    access: check.access,
    principal,
    capabilities,
  });
  if (problem) {
    return { ok: false, error: problem };
  }
  if (principal.type === "department") {
    const department = await forOrg(
      database,
      viewer.orgId
    ).department.findFirst({
      where: { id: principal.id },
      select: { id: true },
    });
    if (!department) {
      return { ok: false, error: "That department isn't there any more." };
    }
  }
  await database.accessGrant.upsert({
    where: targetWhere(target, principal),
    create: {
      orgId: viewer.orgId,
      ...target,
      principalType: principal.type,
      principalId: principalId(principal),
      capabilities,
      grantedBy: viewer.userId,
    },
    update: { capabilities, grantedBy: viewer.userId },
  });
  return { ok: true };
};

/** Remove one grant. */
export const revokeAccess = async (
  viewer: Viewer,
  grantId: string
): Promise<Result> => {
  const grant = await forOrg(
    database,
    trustedViewer(viewer).orgId
  ).accessGrant.findFirst({
    where: { id: grantId },
    select: { folderId: true, sourceId: true, capabilities: true },
  });
  if (!grant) {
    return { ok: false, error: NOT_FOUND };
  }
  // A check constraint guarantees exactly one of the two is set.
  const target: Target = grant.folderId
    ? { folderId: grant.folderId }
    : { sourceId: grant.sourceId ?? "" };
  const check = await managing(viewer, target);
  if (!check.ok) {
    return check;
  }
  if (
    !(viewer.isOwner || covers(check.access.capabilities, grant.capabilities))
  ) {
    return {
      ok: false,
      error: "You can only remove access you have yourself.",
    };
  }
  await forOrg(database, viewer.orgId).accessGrant.deleteMany({
    where: { id: grantId },
  });
  return { ok: true };
};

// Grants a document outside any folder has always implied: everyone in the
// shop may view and download it.
const LEGACY_DOCUMENT_GRANT = {
  principal_type: "everyone",
  principal_id: "",
  capabilities: PRESETS.viewer,
};

interface ChainGrant {
  capabilities: number;
  principal_id: string;
  principal_type: string;
}

type RawTx = Pick<typeof database, "$queryRawUnsafe">;

// The folder `target` sits in, locking the target's row so two changes to
// its access can't interleave.
const PARENT_OF_FOLDER_SQL = `select "parentId" as parent from "Folder" where id = $1 and "orgId" = $2 for update`;
const FOLDER_OF_SOURCE_SQL = `select "folderId" as parent from "Source" where id = $1 and "orgId" = $2 for update`;

const lockedParent = async (tx: RawTx, orgId: string, target: Target) => {
  const [sql, id] =
    "folderId" in target
      ? [PARENT_OF_FOLDER_SQL, target.folderId]
      : [FOLDER_OF_SOURCE_SQL, target.sourceId];
  const [row] = await tx.$queryRawUnsafe<{ parent: string | null }[]>(
    sql,
    id,
    orgId
  );
  return row?.parent ?? null;
};

/** What `target` inherits now, one row per principal. */
const inheritedGrants = async (
  tx: RawTx,
  orgId: string,
  target: Target
): Promise<ChainGrant[]> => {
  const parent = await lockedParent(tx, orgId, target);
  if (parent) {
    return tx.$queryRawUnsafe<ChainGrant[]>(
      "select * from library.chain_grants($1, $2)",
      orgId,
      parent
    );
  }
  // A top-level folder inherits nothing; a document outside any folder
  // inherits the shop-wide reading every such document has had.
  return "sourceId" in target ? [LEGACY_DOCUMENT_GRANT] : [];
};

/**
 * Stop or resume inheriting access from the folder above. Stopping first
 * copies what it inherits onto it, so nobody loses access by surprise;
 * removing those grants afterwards is a deliberate, separate step.
 */
export const setInheritance = async (
  viewer: Viewer,
  target: Target,
  inherit: boolean
): Promise<Result> => {
  const check = await managing(viewer, target);
  if (!check.ok) {
    return check;
  }
  await forOrg(database, viewer.orgId).$transaction(async (tx) => {
    if (!inherit) {
      for (const g of await inheritedGrants(tx, viewer.orgId, target)) {
        const principal = { type: g.principal_type, id: g.principal_id };
        const where = targetWhere(target, principal as Principal);
        const existing = await tx.accessGrant.findUnique({
          where,
          select: { capabilities: true },
        });
        await tx.accessGrant.upsert({
          where,
          create: {
            orgId: viewer.orgId,
            ...target,
            principalType: g.principal_type,
            principalId: g.principal_id,
            capabilities: g.capabilities,
            grantedBy: viewer.userId,
          },
          update: {
            capabilities: combine(existing?.capabilities ?? 0, g.capabilities),
          },
        });
      }
    }
    if ("folderId" in target) {
      await tx.folder.updateMany({
        where: { id: target.folderId },
        data: { inheritAccess: inherit },
      });
    } else {
      await tx.source.updateMany({
        where: { id: target.sourceId },
        data: { inheritAccess: inherit },
      });
    }
  });
  return { ok: true };
};

/**
 * Mark a folder confidential (HR, Finance) or not. Only the owner may: it
 * takes away admins' automatic access to everything inside.
 */
export const setConfidential = async (
  viewer: Viewer,
  folderId: string,
  confidential: boolean
): Promise<Result> => {
  if (!trustedViewer(viewer).isOwner) {
    return {
      ok: false,
      error: "Only the shop's owner can mark a folder confidential.",
    };
  }
  const check = await managing(viewer, { folderId });
  if (!check.ok) {
    return check;
  }
  await forOrg(database, viewer.orgId).folder.updateMany({
    where: { id: folderId },
    data: { confidential },
  });
  return { ok: true };
};
