import "server-only";

import { database, Prisma } from "@repo/database";
import { DOCUMENT, LOCK_NAME_SQL, nameLock } from "../knowledge/documents";
import { audit } from "./audit";
import {
  DEFAULT_FIXED,
  grantCompanyWide,
  hasEveryoneGrant,
  mayManageTopLevel,
  NOT_ALLOWED,
  treeProblem,
} from "./folders";
import { authorizeDocument, authorizeFolder } from "./guard";
import type { Outcome } from "./lifecycle";
import { guardMove, modesOf, settleAiAfterMove } from "./moves";
import { personalMoveProblem, personalOwnerOf } from "./personal";
import { confidentialEnabled } from "./stage";
import { trustedViewer, type Viewer } from "./viewer";

/** A move the access rules refuse (moves.ts); its message is for people. */
class MoveRefused extends Error {}

/**
 * Move a folder (and everything in it) under `parentId`, or to the top.
 * It never becomes more visible: see moves.ts. `adopt`: take the
 * destination's access instead (needs manage on both).
 */
export const moveFolder = async (
  viewer: Viewer,
  folderId: string,
  parentId: string | null,
  { adopt = false }: { adopt?: boolean } = {}
): Promise<Outcome> => {
  const { orgId, userId } = trustedViewer(viewer);
  const allowed = await authorizeFolder(viewer, folderId, "edit");
  if (!allowed.ok) {
    return allowed;
  }
  if (allowed.folder.kind !== "normal") {
    return DEFAULT_FIXED;
  }
  if (parentId) {
    const target = await authorizeFolder(viewer, parentId, "edit");
    if (!target.ok) {
      return target;
    }
  } else if (!mayManageTopLevel(viewer)) {
    return NOT_ALLOWED;
  }
  if (allowed.folder.parentId === parentId) {
    return { ok: true };
  }
  const restricting = await confidentialEnabled(orgId);
  try {
    await database.$transaction(async (tx) => {
      const target = { folderId };
      const personal = await personalMoveProblem(tx, viewer, {
        fromFolder: folderId,
        toFolder: parentId,
      });
      if (personal) {
        throw new MoveRefused(personal);
      }
      const modes = await modesOf(tx, orgId, target);
      const refused = await guardMove(tx, viewer, {
        target,
        from: allowed.folder.parentId,
        to: parentId,
        adopt,
      });
      if (refused) {
        throw new MoveRefused(refused);
      }
      await tx.folder.update({
        where: { id: folderId },
        data: { parentId },
      });
      // At the top a folder no longer inherits: while the shop restricts
      // nothing it keeps company-wide access with its own grant (once it
      // does, guardMove has kept the folder's own access instead).
      if (
        !(
          restricting ||
          parentId ||
          (await hasEveryoneGrant(tx, orgId, folderId))
        )
      ) {
        await grantCompanyWide(tx, orgId, folderId, userId);
      }
      await settleAiAfterMove(tx, orgId, target, modes);
      await audit(
        {
          orgId,
          actorId: userId,
          action: "folder_move",
          folderId,
          detail: { from: allowed.folder.parentId, to: parentId },
        },
        tx
      );
    });
  } catch (error) {
    if (error instanceof MoveRefused) {
      return { ok: false, status: 403, error: error.message };
    }
    const problem = treeProblem(error, allowed.folder.name);
    if (problem) {
      return { ok: false, status: 409, error: problem };
    }
    throw error;
  }
  return { ok: true };
};

const NOT_EMPTY = {
  ok: false,
  status: 409,
  error:
    "Only empty folders can be deleted. Move or delete what's in it first.",
} as const;

/**
 * Delete an empty folder (no folders and no documents in it). Documents in
 * the Trash that came from it are kept and would be restored to the top.
 */
export const deleteFolder = async (
  viewer: Viewer,
  folderId: string
): Promise<Outcome> => {
  const { orgId, userId } = trustedViewer(viewer);
  const allowed = await authorizeFolder(viewer, folderId, "delete");
  if (!allowed.ok) {
    return allowed;
  }
  if (allowed.folder.kind !== "normal") {
    return DEFAULT_FIXED;
  }
  const restricting = await confidentialEnabled(orgId);
  const deleted = await database.$transaction(async (tx) => {
    // Locks the folder: an upload or new subfolder racing this waits, then
    // fails because the folder is gone.
    await tx.$queryRawUnsafe(
      `select id from "Folder" where id = $1 and "orgId" = $2 for update`,
      folderId,
      orgId
    );
    const [children, documents] = await Promise.all([
      tx.folder.count({ where: { orgId, parentId: folderId } }),
      tx.source.count({ where: { orgId, folderId, deletedAt: null } }),
    ]);
    if (children > 0 || documents > 0) {
      return false;
    }
    // Once access can be restricted, its documents in the Trash can't move
    // to the top level (company-wide): they'd be seen by more people.
    if (
      restricting &&
      (await tx.source.count({
        where: { orgId, folderId, deletedAt: { not: null } },
      })) > 0
    ) {
      return "trash" as const;
    }
    // Inside a personal folder they go back to it, never to the top where
    // everyone could see them once restored.
    const personal = await personalOwnerOf(tx, orgId, folderId);
    const home = personal
      ? await tx.folder.findFirst({
          where: { orgId, personalUserId: personal },
          select: { id: true },
        })
      : null;
    await tx.source.updateMany({
      where: { orgId, folderId, deletedAt: { not: null } },
      data: { folderId: home?.id ?? null },
    });
    await tx.folder.delete({ where: { id: folderId } });
    await audit(
      {
        orgId,
        actorId: userId,
        action: "folder_delete",
        folderId,
        detail: { name: allowed.folder.name },
      },
      tx
    );
    return true;
  });
  if (deleted === "trash") {
    return {
      ok: false,
      status: 409,
      error:
        "Documents from this folder are in the Trash. Restore them or delete them permanently first.",
    };
  }
  return deleted ? { ok: true } : NOT_EMPTY;
};

/**
 * Move a document into a folder (or to the top). Needs edit on the document
 * and permission to add documents to the folder; a document with the same
 * name already there is never replaced.
 */
export const moveDocument = async (
  viewer: Viewer,
  sourceId: string,
  folderId: string | null,
  { adopt = false }: { adopt?: boolean } = {}
): Promise<Outcome> => {
  const { orgId, userId } = trustedViewer(viewer);
  const allowed = await authorizeDocument(viewer, sourceId, "edit");
  if (!allowed.ok) {
    return allowed;
  }
  if (folderId) {
    const target = await authorizeFolder(viewer, folderId, "upload");
    if (!target.ok) {
      return target;
    }
    if (target.folder.kind.startsWith("virtual")) {
      return NOT_ALLOWED;
    }
    // Only into folders the mover can open: in a drop box they can't see,
    // a name clash would tell them a hidden document's name (audit G3-F3).
    // Handing a document in there is an upload, which never reveals one.
    if (!(await authorizeFolder(viewer, folderId, "view")).ok) {
      return {
        ok: false,
        status: 403,
        error: "You can only move documents into folders you can open.",
      };
    }
  }
  const { source } = allowed;
  if (source.folderId === folderId) {
    return { ok: true };
  }
  try {
    const moved = await database.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(LOCK_NAME_SQL, nameLock(orgId, source.name));
      const clash = await tx.source.findFirst({
        where: {
          orgId,
          folderId,
          name: source.name,
          deletedAt: null,
          NOT: { id: sourceId },
          ...DOCUMENT,
        },
        select: { id: true },
      });
      if (clash) {
        return false;
      }
      const target = { sourceId };
      const uploader = await tx.source.findFirst({
        where: { id: sourceId, orgId },
        select: { uploadedBy: true },
      });
      const personal = await personalMoveProblem(tx, viewer, {
        fromFolder: source.folderId,
        toFolder: folderId,
        uploadedBy: uploader?.uploadedBy ?? null,
      });
      if (personal) {
        throw new MoveRefused(personal);
      }
      const modes = await modesOf(tx, orgId, target);
      const refused = await guardMove(tx, viewer, {
        target,
        from: source.folderId,
        to: folderId,
        adopt,
      });
      if (refused) {
        throw new MoveRefused(refused);
      }
      await tx.source.update({
        where: { id: sourceId },
        data: { folderId },
      });
      await settleAiAfterMove(tx, orgId, target, modes);
      await audit(
        {
          orgId,
          actorId: userId,
          action: "move",
          sourceId,
          folderId,
          subjectName: source.name,
          detail: { from: source.folderId },
        },
        tx
      );
      return true;
    });
    if (!moved) {
      return {
        ok: false,
        status: 409,
        error: `There's already a document called ${source.name} in that folder.`,
      };
    }
  } catch (error) {
    if (error instanceof MoveRefused) {
      return { ok: false, status: 403, error: error.message };
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return {
        ok: false,
        status: 409,
        error: `There's already a document called ${source.name} in that folder.`,
      };
    }
    throw error;
  }
  return { ok: true };
};
