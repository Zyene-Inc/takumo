import "server-only";

import { database, forOrg, type Prisma } from "@repo/database";
import { type Access, requireCapability, type Target } from "./access";
import { serialized } from "./access-lock";
import { audit } from "./audit";
import {
  CAPABILITY,
  capabilitiesProblem,
  combine,
  covers,
  PRESETS,
} from "./capabilities";
import { NOT_SHAREABLE, personalOwnerOf } from "./personal";
import { confidentialEnabled, NOT_YET } from "./stage";
import { trustedViewer, type Viewer } from "./viewer";

// Changing who may do what with a folder or document. Every change needs
// "manage" on it, gives at most what the changer holds (the owner excepted),
// and is refused while restricted access is switched off (stage.ts).

export type Principal =
  | { type: "everyone" }
  | { type: "role" | "department" | "user"; id: string };

export type Result = { ok: true } | { ok: false; error: string };

/** Where an access change is recorded in the audit log. */
export const auditTarget = (target: Target) =>
  "folderId" in target
    ? { folderId: target.folderId }
    : { sourceId: target.sourceId };

const NOT_FOUND = "That folder or document isn't there any more.";
const NOT_MANAGER = "Only someone who manages it can change who has access.";

/** The viewer may change access to `target`: its access, or why not. */
export const managing = async (
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
  // Nothing in a personal folder is shared: its person alone may open it.
  const folderId =
    "folderId" in target
      ? target.folderId
      : ((
          await database.source.findFirst({
            where: { id: target.sourceId, orgId: viewer.orgId },
            select: { folderId: true },
          })
        )?.folderId ?? null);
  if (await personalOwnerOf(database, viewer.orgId, folderId)) {
    return { ok: false, error: NOT_SHAREABLE };
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
export const grantAccess = serialized(
  async (
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
    await audit({
      orgId: viewer.orgId,
      actorId: viewer.userId,
      action: "access_grant",
      ...auditTarget(target),
      detail: {
        principal: principal.type,
        id: principalId(principal),
        capabilities,
      },
    });
    return { ok: true };
  }
);

/** Remove one grant. */
export const revokeAccess = serialized(
  async (viewer: Viewer, grantId: string): Promise<Result> => {
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
    const removed = await forOrg(database, viewer.orgId).accessGrant.deleteMany(
      {
        where: { id: grantId },
      }
    );
    if (removed.count > 0) {
      await audit({
        orgId: viewer.orgId,
        actorId: viewer.userId,
        action: "access_revoke",
        ...auditTarget(target),
        detail: { capabilities: grant.capabilities },
      });
    }
    return { ok: true };
  }
);

// Grants a document outside any folder has always implied: everyone in the
// shop may view and download it.
const LEGACY_DOCUMENT_GRANT = {
  principal_type: "everyone",
  principal_id: "",
  capabilities: PRESETS.viewer,
};

export interface ChainGrant {
  capabilities: number;
  principal_id: string;
  principal_type: string;
}

type RawTx = Pick<typeof database, "$queryRawUnsafe">;

// The folder `target` sits in, locking the target's row so two changes to
// its access can't interleave.
const PARENT_OF_FOLDER_SQL = `select "parentId" as parent from "Folder" where id = $1 and "orgId" = $2 for update`;
const FOLDER_OF_SOURCE_SQL = `select "folderId" as parent from "Source" where id = $1 and "orgId" = $2 for update`;

/** The folder an item is in now (null: top level), its row locked until the transaction ends. */
export const lockedParent = async (
  tx: RawTx,
  orgId: string,
  target: Target
) => {
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

/**
 * What an item would inherit with `parent` above it (null: top level), one
 * row per principal.
 */
export const grantsUnder = (
  tx: RawTx,
  orgId: string,
  parent: string | null,
  isDocument: boolean
): Promise<ChainGrant[]> => {
  if (parent) {
    return tx.$queryRawUnsafe<ChainGrant[]>(
      "select * from library.chain_grants($1, $2)",
      orgId,
      parent
    );
  }
  // A top-level folder inherits nothing; a document outside any folder
  // inherits the shop-wide reading every such document has had.
  return Promise.resolve(isDocument ? [LEGACY_DOCUMENT_GRANT] : []);
};

/**
 * What `target` inherits now, one row per principal (its row locked). A
 * confidential folder inherits nothing (library.folder_grants, audit H1).
 */
export const inheritedGrants = async (
  tx: RawTx,
  orgId: string,
  target: Target
): Promise<ChainGrant[]> => {
  const parent = await lockedParent(tx, orgId, target);
  if ("folderId" in target) {
    const [own] = await tx.$queryRawUnsafe<{ confidential: boolean }[]>(
      `select confidential from "Folder" where id = $1 and "orgId" = $2`,
      target.folderId,
      orgId
    );
    if (own?.confidential) {
      return [];
    }
  }
  return grantsUnder(tx, orgId, parent, "sourceId" in target);
};

/** The same grants, as "principal → capabilities". */
export const grantKey = (grants: ChainGrant[]) =>
  grants
    .map((g) => `${g.principal_type}:${g.principal_id}=${g.capabilities}`)
    .sort()
    .join("|");

/**
 * Stop `target` inheriting, copying `grants` (what it inherited) onto it
 * first, so nobody loses access by surprise. Inside the caller's
 * transaction.
 */
export const freezeAccess = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  target: Target,
  grants: ChainGrant[],
  grantedBy: string | null
) => {
  for (const g of grants) {
    const principal = { type: g.principal_type, id: g.principal_id };
    const where = targetWhere(target, principal as Principal);
    const existing = await tx.accessGrant.findUnique({
      where,
      select: { capabilities: true },
    });
    await tx.accessGrant.upsert({
      where,
      create: {
        orgId,
        ...target,
        principalType: g.principal_type,
        principalId: g.principal_id,
        capabilities: g.capabilities,
        grantedBy,
      },
      update: {
        capabilities: combine(existing?.capabilities ?? 0, g.capabilities),
      },
    });
  }
  if ("folderId" in target) {
    await tx.folder.updateMany({
      where: { id: target.folderId, orgId },
      data: { inheritAccess: false },
    });
  } else {
    await tx.source.updateMany({
      where: { id: target.sourceId, orgId },
      data: { inheritAccess: false },
    });
  }
};

export {
  type InheritanceResult,
  inheritanceGain,
  setConfidential,
  setInheritance,
} from "./grant-inheritance";
