import "server-only";

import { database, type Prisma } from "@repo/database";
import { trustedViewer, type Viewer } from "./viewer";

// Personal folders: one per member, that only they can open. Not the shop's
// owner, not admins, not a grant (library.personal_folders, used by
// folder_access and document_grants, decides). Here: making them and telling
// whether something is inside one. Deleting a leaver's folder after the
// grace period: personal-sweep.ts.

/** How long a leaver's folder waits before it is deleted for good. */
export const LEAVER_GRACE_DAYS = 30;

export const PERSONAL_NAME = "Personal";

export const NOT_SHAREABLE =
  "Your Personal folder is only for you: it and what's in it can't be shared.";

type Client = Prisma.TransactionClient | typeof database;

const INSERT_SQL = `
  insert into "Folder"
    (id, "orgId", name, kind, "personalUserId", "createdBy", "updatedAt")
  values ($1, $2, $3, 'personal', $4, $4, now())
  on conflict ("orgId", "personalUserId") where "personalUserId" is not null
  do nothing`;

/**
 * The viewer's personal folder, made the first time they open the library.
 * A member back within the grace period keeps theirs.
 */
export const ensurePersonalFolder = async (viewer: Viewer) => {
  const { orgId, userId, isSystem } = trustedViewer(viewer);
  if (isSystem || !userId) {
    return;
  }
  await database.$executeRawUnsafe(
    INSERT_SQL,
    crypto.randomUUID(),
    orgId,
    PERSONAL_NAME,
    userId
  );
  await database.folder.updateMany({
    where: { orgId, personalUserId: userId, deleteAfter: { not: null } },
    data: { deleteAfter: null },
  });
};

/** Whose personal folder `folderId` is inside (or is), or null. */
export const personalOwnerOf = async (
  client: Client,
  orgId: string,
  folderId: string | null
): Promise<string | null> => {
  if (!folderId) {
    return null;
  }
  const [row] = await client.$queryRawUnsafe<{ personal_user: string }[]>(
    "select personal_user from library.personal_folders($1) where folder_id = $2",
    orgId,
    folderId
  );
  return row?.personal_user ?? null;
};

/** Whether a document sits in someone's personal folder. */
export const isPersonalDocument = async (orgId: string, sourceId: string) => {
  const source = await database.source.findFirst({
    where: { id: sourceId, orgId },
    select: { folderId: true },
  });
  return Boolean(
    await personalOwnerOf(database, orgId, source?.folderId ?? null)
  );
};

/**
 * Why `target` can't receive something now in `fromFolder` (null: it can).
 * Into a personal folder go only the person's own uploads, or what is
 * already theirs: nobody can hide the shop's documents from everyone else.
 */
export const personalMoveProblem = async (
  client: Client,
  viewer: Viewer,
  {
    fromFolder,
    toFolder,
    uploadedBy,
  }: {
    fromFolder: string | null;
    toFolder: string | null;
    /** A document's uploader; undefined when a folder is moving. */
    uploadedBy?: string | null;
  }
): Promise<string | null> => {
  const { orgId, userId } = trustedViewer(viewer);
  const into = await personalOwnerOf(client, orgId, toFolder);
  if (!into) {
    return null;
  }
  if (into !== userId) {
    return "That folder doesn't exist.";
  }
  if ((await personalOwnerOf(client, orgId, fromFolder)) === userId) {
    return null;
  }
  if (uploadedBy !== undefined && uploadedBy === userId) {
    return null;
  }
  return uploadedBy === undefined
    ? "Only folders already in your Personal folder can move around inside it."
    : "Only documents you uploaded can go into your Personal folder.";
};

/** The person left the shop: their folder is deleted after the grace period. */
export const markLeaverFolder = (orgId: string, userId: string) =>
  database.folder.updateMany({
    where: { orgId, personalUserId: userId, deleteAfter: null },
    data: {
      deleteAfter: new Date(Date.now() + LEAVER_GRACE_DAYS * 86_400_000),
    },
  });
