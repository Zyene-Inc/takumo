import "server-only";

import { database, type Prisma } from "@repo/database";
import { audit } from "./audit";
import { PRESETS } from "./capabilities";
import { NOT_YET, restrictedAccessReady } from "./stage";
import { trustedViewer, type Viewer } from "./viewer";

// Turning on restricted access for a shop (Org.libraryStage "confidential"):
// departments, restricted and confidential folders and folder AI settings.
// Only the shop's owner may, only once the code-level switch is on
// (stage.ts), and it can't be turned off here: going back would show
// restricted documents to everyone. The confidential default folders are
// made at the same moment, so HR files can't be uploaded before the
// protections exist. They start with AI processing off; nobody but the
// owner can open them until their departments have members.

export const CONFIDENTIAL_FOLDERS = [
  { key: "hr", name: "HR", department: "Human Resources", dropBox: false },
  { key: "finance", name: "Finance", department: "Finance", dropBox: false },
  // Everyone hands receipts in; only Finance (and each uploader, their own) sees them.
  { key: "receipts", name: "Receipts", department: "Finance", dropBox: true },
  {
    key: "contracts",
    name: "Contracts",
    department: "Management",
    dropBox: false,
  },
] as const;

type Result = { ok: true } | { ok: false; error: string };

const departmentId = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  name: string,
  userId: string | null
) =>
  (
    (await tx.department.findFirst({
      where: { orgId, name },
      select: { id: true },
    })) ??
    (await tx.department.create({
      data: { orgId, name, createdBy: userId },
      select: { id: true },
    }))
  ).id;

/** The confidential default folders, made once (turnOnRestrictedAccess refuses while a name is taken). */
const makeConfidentialFolders = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  userId: string | null
) => {
  for (const f of CONFIDENTIAL_FOLDERS) {
    const exists = await tx.folder.findFirst({
      where: {
        orgId,
        OR: [{ systemKey: f.key }, { parentId: null, name: f.name }],
      },
      select: { id: true },
    });
    if (exists) {
      continue;
    }
    const folder = await tx.folder.create({
      data: {
        orgId,
        name: f.name,
        kind: "system",
        systemKey: f.key,
        confidential: true,
        inheritAccess: false,
        aiMode: "off",
        createdBy: userId,
      },
      select: { id: true },
    });
    const grants: Prisma.AccessGrantCreateManyInput[] = [
      {
        orgId,
        folderId: folder.id,
        principalType: "department",
        principalId: await departmentId(tx, orgId, f.department, userId),
        capabilities: PRESETS.editor,
        grantedBy: userId,
      },
    ];
    if (f.dropBox) {
      grants.push({
        orgId,
        folderId: folder.id,
        principalType: "everyone",
        principalId: "",
        capabilities: PRESETS.dropBox,
        grantedBy: userId,
      });
    }
    await tx.accessGrant.createMany({ data: grants });
  }
};

/** The owner turns on restricted access (one way). */
export const turnOnRestrictedAccess = async (
  viewer: Viewer
): Promise<Result> => {
  const { orgId, userId, isOwner } = trustedViewer(viewer);
  if (!restrictedAccessReady()) {
    return { ok: false, error: NOT_YET };
  }
  if (!(isOwner && userId)) {
    return {
      ok: false,
      error: "Only the shop's owner can turn on restricted access.",
    };
  }
  const done = await database.$transaction(async (tx) => {
    // An ordinary top-level folder already called "HR" (say) would be left
    // company-wide while turning on reported success (audit M5): refuse, and
    // say which to rename, before anything changes.
    const clashes = await tx.folder.findMany({
      where: {
        orgId,
        parentId: null,
        systemKey: null,
        name: { in: CONFIDENTIAL_FOLDERS.map((f) => f.name) },
      },
      select: { name: true },
      orderBy: { name: "asc" },
    });
    if (clashes.length > 0) {
      return { clashes: clashes.map((c) => c.name) };
    }
    // Only from the library stage, and only by the owner on record now.
    const { count } = await tx.org.updateMany({
      where: { id: orgId, ownerUserId: userId, libraryStage: "library" },
      data: { libraryStage: "confidential" },
    });
    if (count === 0) {
      return false;
    }
    await makeConfidentialFolders(tx, orgId, userId);
    await audit(
      {
        orgId,
        actorId: userId,
        action: "folder_confidential",
        detail: { restrictedAccess: true },
      },
      tx
    );
    return true;
  });
  if (typeof done === "object") {
    const names = done.clashes.map((n) => `"${n}"`).join(", ");
    return {
      ok: false,
      error: `Rename or move the folder${done.clashes.length > 1 ? "s" : ""} ${names} first: restricted access makes new confidential folders with ${done.clashes.length > 1 ? "those names" : "that name"}.`,
    };
  }
  return done
    ? { ok: true }
    : {
        ok: false,
        error:
          "Restricted access can only be turned on once the shop uses the library.",
      };
};
