import "server-only";

import { can } from "@repo/auth/permissions";
import { database, Prisma } from "@repo/database";
import { DOCUMENT, LOCK_NAME_SQL, nameLock } from "../knowledge/documents";
import { audit } from "./audit";
import { PRESETS } from "./capabilities";
import { authorizeDocument, authorizeFolder } from "./guard";
import type { Outcome } from "./lifecycle";
import { trustedViewer, type Viewer } from "./viewer";

// Folders of the Company Knowledge Library, and moving documents between
// them. Every change starts from a viewer made on the server and is checked
// with the Knowledge Hub's capabilities (guard.ts); the database keeps the
// tree right (folder_before_write: same shop, no folder inside itself, at
// most 20 deep).
//
// In this release everything is company-wide: a top-level folder gets one
// grant, "everyone may view, download and add documents", and its
// subfolders inherit it, the same as documents outside any folder. Who may
// create, rename, move and delete is decided as for documents: today's
// knowledge:write roles (owner, admin, planner, estimator).

/** Everyone in the shop: view, download and add documents. */
const COMPANY_WIDE = PRESETS.contributor;

export const MAX_FOLDER_NAME = 120;
export const MAX_DEPTH = 20;

/** The library's default folders, made the first time a shop opens it. */
export const DEFAULT_FOLDERS = [
  { key: "general", name: "General" },
  { key: "sops", name: "SOPs" },
  { key: "engineering", name: "Engineering" },
] as const;

const SPACES = /\s+/g;
// Control characters (newlines, tabs, NUL…) can't be part of a name.
const CONTROL = /\p{Cc}/u;

/** A folder name as stored, or a message saying what's wrong with it. */
export const folderName = (
  raw: unknown
): { ok: true; name: string } | { ok: false; error: string } => {
  if (typeof raw !== "string") {
    return { ok: false, error: "Give the folder a name." };
  }
  const name = raw.replace(SPACES, " ").trim();
  if (!name) {
    return { ok: false, error: "Give the folder a name." };
  }
  if (name.length > MAX_FOLDER_NAME) {
    return {
      ok: false,
      error: `Folder names can be up to ${MAX_FOLDER_NAME} characters.`,
    };
  }
  if (CONTROL.test(raw)) {
    return { ok: false, error: "That name has characters folders can't use." };
  }
  return { ok: true, name };
};

const grantCompanyWide = (
  tx: Prisma.TransactionClient,
  orgId: string,
  folderId: string,
  grantedBy: string | null
) =>
  tx.accessGrant.create({
    data: {
      orgId,
      folderId,
      principalType: "everyone",
      principalId: "",
      capabilities: COMPANY_WIDE,
      grantedBy,
    },
  });

/** Whether a top-level folder already lets everyone in. */
const hasEveryoneGrant = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  folderId: string
) =>
  (await tx.accessGrant.count({
    where: { orgId, folderId, principalType: "everyone" },
  })) > 0;

const INSERT_DEFAULT_SQL = `
  insert into "Folder" (id, "orgId", name, kind, "systemKey", "updatedAt")
  values ($1, $2, $3, 'system', $4, now())
  on conflict do nothing
  returning id`;

/**
 * Make the default folders (General, SOPs, Engineering) if this shop doesn't
 * have them yet. Safe to run on every visit and at the same time: a folder
 * that exists (or a custom one with that name) is left alone.
 */
export const ensureDefaultFolders = async (orgId: string) => {
  const have = await database.folder.count({
    where: { orgId, systemKey: { in: DEFAULT_FOLDERS.map((f) => f.key) } },
  });
  if (have === DEFAULT_FOLDERS.length) {
    return;
  }
  for (const folder of DEFAULT_FOLDERS) {
    await database.$transaction(async (tx) => {
      const [made] = await tx.$queryRawUnsafe<{ id: string }[]>(
        INSERT_DEFAULT_SQL,
        crypto.randomUUID(),
        orgId,
        folder.name,
        folder.key
      );
      if (made) {
        await grantCompanyWide(tx, orgId, made.id, null);
      }
    });
  }
};

const TAKEN = (name: string) =>
  `There's already a folder called ${name} here. Choose another name.`;

/** What the database said, in words for people (null: not one we expect). */
const treeProblem = (error: unknown, name: string) => {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    return TAKEN(name);
  }
  const text = String(error);
  if (text.includes("at most 20 deep")) {
    return `Folders can be nested at most ${MAX_DEPTH} levels deep.`;
  }
  if (text.includes("inside itself")) {
    return "A folder can't be moved inside itself.";
  }
  if (text.includes("Folder_orgId_root_name_key")) {
    return TAKEN(name);
  }
  return null;
};

const mayManageTopLevel = (viewer: Viewer) =>
  viewer.isOwner || viewer.isAdmin || can(viewer.role, "knowledge:write");

const NOT_ALLOWED = {
  ok: false,
  status: 403,
  error: "You don't have permission to change folders.",
} as const;

const DEFAULT_FIXED = {
  ok: false,
  status: 409,
  error: "The library's default folders can't be renamed, moved or deleted.",
} as const;

/** A new folder, at the top or inside `parentId`. */
export const createFolder = async (
  viewer: Viewer,
  parentId: string | null,
  rawName: unknown
): Promise<Outcome<{ id: string }>> => {
  const { orgId, userId } = trustedViewer(viewer);
  const named = folderName(rawName);
  if (!named.ok) {
    return { ok: false, status: 400, error: named.error };
  }
  if (parentId) {
    const parent = await authorizeFolder(viewer, parentId, "edit");
    if (!parent.ok) {
      return parent;
    }
    if (parent.folder.depth >= MAX_DEPTH) {
      return {
        ok: false,
        status: 400,
        error: `Folders can be nested at most ${MAX_DEPTH} levels deep.`,
      };
    }
  } else if (!mayManageTopLevel(viewer)) {
    return NOT_ALLOWED;
  }
  const id = crypto.randomUUID();
  try {
    await database.$transaction(async (tx) => {
      await tx.folder.create({
        data: { id, orgId, parentId, name: named.name, createdBy: userId },
      });
      if (!parentId) {
        await grantCompanyWide(tx, orgId, id, userId);
      }
      await audit(
        {
          orgId,
          actorId: userId,
          action: "folder_create",
          folderId: id,
          detail: { name: named.name },
        },
        tx
      );
    });
  } catch (error) {
    const problem = treeProblem(error, named.name);
    if (problem) {
      return { ok: false, status: 409, error: problem };
    }
    throw error;
  }
  return { ok: true, id };
};

export const renameFolder = async (
  viewer: Viewer,
  folderId: string,
  rawName: unknown
): Promise<Outcome> => {
  const { orgId, userId } = trustedViewer(viewer);
  const named = folderName(rawName);
  if (!named.ok) {
    return { ok: false, status: 400, error: named.error };
  }
  const allowed = await authorizeFolder(viewer, folderId, "edit");
  if (!allowed.ok) {
    return allowed;
  }
  if (allowed.folder.kind !== "normal") {
    return DEFAULT_FIXED;
  }
  try {
    await database.folder.update({
      where: { id: folderId },
      data: { name: named.name },
    });
  } catch (error) {
    const problem = treeProblem(error, named.name);
    if (problem) {
      return { ok: false, status: 409, error: problem };
    }
    throw error;
  }
  await audit({
    orgId,
    actorId: userId,
    action: "folder_rename",
    folderId,
    detail: { from: allowed.folder.name, to: named.name },
  });
  return { ok: true };
};

/** Move a folder (and everything in it) under `parentId`, or to the top. */
export const moveFolder = async (
  viewer: Viewer,
  folderId: string,
  parentId: string | null
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
  try {
    await database.$transaction(async (tx) => {
      await tx.folder.update({
        where: { id: folderId },
        data: { parentId },
      });
      // At the top a folder no longer inherits: it keeps company-wide
      // access with its own grant.
      if (!(parentId || (await hasEveryoneGrant(tx, orgId, folderId)))) {
        await grantCompanyWide(tx, orgId, folderId, userId);
      }
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
    await tx.source.updateMany({
      where: { orgId, folderId, deletedAt: { not: null } },
      data: { folderId: null },
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
  folderId: string | null
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
      await tx.source.update({
        where: { id: sourceId },
        data: { folderId },
      });
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
