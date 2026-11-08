import "server-only";

import type { Prisma } from "@repo/database";
import { accessTo, type Target } from "./access";
import { type AiMode, invalidateAi, isAiMode, lower } from "./ai-mode";
import { has, onlyUpload } from "./capabilities";
import { type ChainGrant, freezeAccess, grantKey, grantsUnder } from "./grants";
import { confidentialEnabled } from "./stage";
import { trustedViewer, type Viewer } from "./viewer";

// Moving a document or folder can never make it more visible (Knowledge Hub
// design §7), checked on the server inside the move's transaction:
//
// - Leaving a confidential folder for one that isn't needs the owner.
// - When the item inherits access and the folder it goes to would give
//   different access, it stops inheriting and keeps a copy of what it had:
//   nobody gains or loses access by the move. "Use the destination's
//   access" instead needs manage on the item and on the destination.
// - Going somewhere with a stricter AI setting removes what AI services
//   derived from its documents (ai-mode.ts), in the same transaction.
//
// While the shop restricts nothing (stage.ts), every folder is company-wide
// and only the AI part applies.

export interface MovePlan {
  /** The destination's access instead of keeping the item's own. */
  adopt: boolean;
  /** The folder it's in now (null: top level). */
  from: string | null;
  target: Target;
  /** The folder it goes to (null: top level). */
  to: string | null;
}

const OWNER_ONLY =
  "Only the shop's owner can move something out of a confidential folder.";
const ADOPT_NEEDS_MANAGE =
  "Using the destination's access needs permission to manage both this item and the folder it goes to.";

const isConfidentialFolder = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  folderId: string | null
) => {
  if (!folderId) {
    return false;
  }
  const folder = await tx.folder.findFirst({
    where: { id: folderId, orgId },
    select: { path: true },
  });
  if (!folder) {
    return false;
  }
  return (
    (await tx.folder.count({
      where: { orgId, id: { in: folder.path }, confidential: true },
    })) > 0
  );
};

/** Whether the item is itself a confidential folder, and whether it inherits access. */
const itemFlags = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  target: Target
) => {
  if ("folderId" in target) {
    const folder = await tx.folder.findFirst({
      where: { id: target.folderId, orgId },
      select: { confidential: true, inheritAccess: true },
    });
    return {
      ownFlag: Boolean(folder?.confidential),
      inherits: Boolean(folder?.inheritAccess),
    };
  }
  const source = await tx.source.findFirst({
    where: { id: target.sourceId, orgId },
    select: { inheritAccess: true },
  });
  return { ownFlag: false, inherits: Boolean(source?.inheritAccess) };
};

/**
 * What `grants` allowed inside a confidential folder: everyone-wide and
 * role-wide grants only ever allowed uploading there (library.allowed). A
 * copy taken when leaving one keeps only that, so the move can't widen
 * access (security audit H1).
 */
const asConfidential = (grants: ChainGrant[]) =>
  grants
    .map((g) =>
      g.principal_type === "everyone" || g.principal_type === "role"
        ? { ...g, capabilities: onlyUpload(g.capabilities) }
        : g
    )
    .filter((g) => g.capabilities !== 0);

/**
 * Before the move is written: why it isn't allowed, or null. Copies the
 * item's access onto it when the move would change what it inherits.
 */
export const guardMove = async (
  tx: Prisma.TransactionClient,
  viewer: Viewer,
  plan: MovePlan
): Promise<string | null> => {
  const { orgId, userId, isOwner } = trustedViewer(viewer);
  if (!(await confidentialEnabled(orgId))) {
    return null;
  }
  const { target, from, to, adopt } = plan;
  const isDocument = "sourceId" in target;
  const now = await accessTo(viewer, target);
  if (!now) {
    return "That isn't there any more.";
  }
  const { ownFlag, inherits } = await itemFlags(tx, orgId, target);
  const after = ownFlag || (await isConfidentialFolder(tx, orgId, to));
  if (now.confidential && !after && !isOwner) {
    return OWNER_ONLY;
  }
  if (adopt) {
    const destination = to ? await accessTo(viewer, { folderId: to }) : null;
    const managesDestination = to
      ? Boolean(destination && has(destination.capabilities, "manage"))
      : isOwner;
    return has(now.capabilities, "manage") && managesDestination
      ? null
      : ADOPT_NEEDS_MANAGE;
  }
  // A confidential folder inherits nothing wherever it is (audit H1).
  if (!inherits || ownFlag) {
    return null;
  }
  const [inherited, there] = await Promise.all([
    grantsUnder(tx, orgId, from, isDocument),
    grantsUnder(tx, orgId, to, isDocument),
  ]);
  const before =
    now.confidential && !after ? asConfidential(inherited) : inherited;
  // Any move into or out of a confidential folder keeps the item's own copy
  // of its access, even when the two places look the same (audit H1).
  if (grantKey(before) !== grantKey(there) || now.confidential || after) {
    await freezeAccess(tx, orgId, target, before, userId);
  }
  return null;
};

const DOCUMENT_MODES_SQL = `
  select m.source_id as id, m.ai_mode
  from library.document_ai_modes($1) m
  join "Source" s on s.id = m.source_id
  left join "Folder" f on f.id = s."folderId"
  where ($2::text is not null and s.id = $2)
     or ($3::text is not null and $3 = any (f.path))`;

/** The AI setting of the documents a move touches (a document, or a folder's). */
export const modesOf = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  target: Target
) =>
  new Map<string, AiMode>(
    (
      await tx.$queryRawUnsafe<{ ai_mode: string; id: string }[]>(
        DOCUMENT_MODES_SQL,
        orgId,
        "sourceId" in target ? target.sourceId : null,
        "folderId" in target ? target.folderId : null
      )
    ).map((r) => [r.id, isAiMode(r.ai_mode) ? r.ai_mode : "off"])
  );

/**
 * After the move is written: remove what AI services derived from documents
 * whose setting is now stricter than before.
 */
export const settleAiAfterMove = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  target: Target,
  before: Map<string, AiMode>
) => {
  const after = await modesOf(tx, orgId, target);
  const stricter = [...after]
    .filter(([id, mode]) => {
      const was = before.get(id);
      return was !== undefined && lower(mode, was);
    })
    .map(([id]) => id);
  await invalidateAi(tx, orgId, stricter);
};
