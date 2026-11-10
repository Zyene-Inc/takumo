import "server-only";

import { shopRole } from "@repo/auth/server";
import { database } from "@repo/database";
import { audit } from "./audit";
import { purgeSource } from "./lifecycle";
import { markLeaverFolder } from "./personal";

// Leavers' personal folders: deleted for good once the grace period after
// they leave is over (personal.ts). Run daily by the erp-health cron.

/** Every folder in a personal folder's tree, deepest first. */
const treeOf = (orgId: string, rootId: string) =>
  database.folder.findMany({
    where: { orgId, path: { has: rootId } },
    orderBy: { depth: "desc" },
    select: { id: true },
  });

/**
 * Daily: mark the folders of people no longer in their shop (a backstop for
 * the WorkOS webhook), and delete for good those whose grace period is over.
 * Someone back in the shop keeps theirs. Each folder's documents (live and in
 * the Trash) are purged with their files, then its folders.
 */
export const sweepPersonalFolders = async (now = new Date()) => {
  let marked = 0;
  let deleted = 0;
  const folders = await database.folder.findMany({
    where: { kind: "personal" },
    select: { id: true, orgId: true, personalUserId: true, deleteAfter: true },
  });
  for (const f of folders) {
    const userId = f.personalUserId as string;
    const member = Boolean(await shopRole(userId, f.orgId));
    if (member) {
      if (f.deleteAfter) {
        await database.folder.update({
          where: { id: f.id },
          data: { deleteAfter: null },
        });
      }
      continue;
    }
    if (!f.deleteAfter) {
      await markLeaverFolder(f.orgId, userId);
      marked += 1;
      continue;
    }
    if (f.deleteAfter > now) {
      continue;
    }
    const tree = await treeOf(f.orgId, f.id);
    const sources = await database.source.findMany({
      where: { orgId: f.orgId, folderId: { in: tree.map((t) => t.id) } },
      select: { id: true },
    });
    for (const s of sources) {
      await purgeSource(f.orgId, s.id, null);
    }
    await database.$transaction(async (tx) => {
      for (const t of tree) {
        await tx.folder.delete({ where: { id: t.id } });
      }
      await audit(
        {
          orgId: f.orgId,
          actorId: null,
          action: "folder_delete",
          folderId: f.id,
          detail: { personal: true, documents: sources.length },
        },
        tx
      );
    });
    deleted += 1;
  }
  return { marked, deleted };
};
