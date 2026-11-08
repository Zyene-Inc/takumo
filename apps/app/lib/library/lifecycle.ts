import "server-only";

import { database, type Prisma } from "@repo/database";
import { log } from "@repo/observability/log";
import { DOCUMENT, LOCK_NAME_SQL, nameLock } from "../knowledge/documents";
import { requireCapability } from "./access";
import { audit } from "./audit";
import { authorizeDocument } from "./guard";
import { REMOVED_ANSWER } from "./provenance";
import { confidentialEnabled } from "./stage";
import { objectStore } from "./storage";
import { trustedViewer, type Viewer } from "./viewer";

// Trash, restore and permanent delete.
//
// Trash hides a document at once from the library, search and Ask (they
// only read documents with no deletedAt) and keeps everything for restoring.
// Permanent delete removes the document's text, passages, vectors, versions,
// grants and the facts that came only from it, rewrites saved answers that
// used it, clears its name from the audit log, and queues its stored files
// for deletion. It reports "complete" only once storage confirms the files
// are gone; until then the sweep keeps retrying.

export type Outcome<T = object> =
  | ({ ok: true } & T)
  | { ok: false; status: number; error: string };

/** Move a document to the Trash. Doing it twice is fine. */
export const trashDocument = async (
  viewer: Viewer,
  sourceId: string
): Promise<Outcome> => {
  const { orgId, userId } = trustedViewer(viewer);
  const allowed = await authorizeDocument(viewer, sourceId, "delete", {
    trashed: true,
  });
  if (!allowed.ok) {
    return allowed;
  }
  const { count } = await database.source.updateMany({
    where: { id: sourceId, orgId, deletedAt: null },
    data: { deletedAt: new Date(), deletedBy: userId },
  });
  if (count > 0) {
    await audit({
      orgId,
      actorId: userId,
      action: "trash",
      sourceId,
      folderId: allowed.source.folderId,
      subjectName: allowed.source.name,
    });
  }
  return { ok: true };
};

/** A name for the restored document that no live document in the folder has. */
const freeName = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  folderId: string | null,
  name: string
) => {
  for (let n = 1; ; n += 1) {
    // Name, Name (restored), Name (restored 2), …
    const suffix = n > 2 ? ` (restored ${n - 1})` : " (restored)";
    const candidate = n === 1 ? name : `${name.slice(0, 140)}${suffix}`;
    await tx.$executeRawUnsafe(LOCK_NAME_SQL, nameLock(orgId, candidate));
    const taken = await tx.source.findFirst({
      where: { orgId, folderId, name: candidate, deletedAt: null, ...DOCUMENT },
      select: { id: true },
    });
    if (!taken) {
      return candidate;
    }
  }
};

/**
 * Bring a document back from the Trash: to its folder when that still
 * exists and the viewer may upload there, otherwise to the top level. If a
 * live document has its name meanwhile, it comes back as "Name (restored)".
 */
export const restoreDocument = async (
  viewer: Viewer,
  sourceId: string
): Promise<Outcome<{ name: string }>> => {
  const { orgId, userId } = trustedViewer(viewer);
  const allowed = await authorizeDocument(viewer, sourceId, "delete", {
    trashed: true,
  });
  if (!allowed.ok) {
    return allowed;
  }
  const { source } = allowed;
  if (!source.deletedAt) {
    return { ok: true, name: source.name };
  }
  let folderId = source.folderId;
  if (folderId) {
    const mayUpload = await requireCapability(viewer, { folderId }, "upload");
    if (!mayUpload.ok) {
      // Once access can be restricted, it never comes back anywhere more
      // open than where it was.
      if (await confidentialEnabled(orgId)) {
        return {
          ok: false,
          status: 403,
          error:
            "Restoring it needs permission to add documents to its folder.",
        };
      }
      folderId = null;
    }
  }
  const name = await database.$transaction(async (tx) => {
    const free = await freeName(tx, orgId, folderId, source.name);
    const { count } = await tx.source.updateMany({
      where: { id: sourceId, orgId, deletedAt: { not: null } },
      data: { deletedAt: null, deletedBy: null, folderId, name: free },
    });
    if (count > 0) {
      await audit(
        {
          orgId,
          actorId: userId,
          action: "restore",
          sourceId,
          folderId,
          subjectName: free,
          detail: { renamed: free !== source.name },
        },
        tx
      );
    }
    return free;
  });
  return { ok: true, name };
};

// Saved answers that used the document: those whose recorded sources name
// it (directly or through an earlier answer), and older answers that link
// to it (their citations and tool results hold its exact id).
const REWRITE_MESSAGES_SQL = `
  with hit as (
    select m.id
    from "Message" m
    join "Conversation" c on c.id = m."conversationId"
    where c."orgId" = $1 and m.role = 'assistant'
      and (
        m.id in (select "messageId" from "MessageSource" where "orgId" = $1 and "sourceId" = $2)
        or strpos(coalesce(m.citations::text, ''), $3) > 0
        or strpos(coalesce(m.parts::text, ''), $3) > 0
        or strpos(coalesce(m."toolCalls"::text, ''), $3) > 0
      )
  )
  update "Message" m
  set content = $4,
      parts = jsonb_build_array(jsonb_build_object('type', 'text', 'text', $4::text)),
      citations = null,
      "toolCalls" = null,
      provenance = 'removed'
  from hit
  where hit.id = m.id`;

/**
 * Facts that came from the document. Removing a document must never make a
 * fact more visible: whoever may open the documents left could be more
 * people than could open this one. So, unless the fact was published to the
 * company on purpose:
 * - still stated by other documents: kept, seen by the owner only
 *   ("source_deleted") until someone publishes it again;
 * - from this document only: pending and rejected facts are deleted;
 *   approved ones are kept (a supervisor accepted the value, and it may be
 *   in the shop's records) but seen by the owner only.
 * The deleted document's words always go.
 */
const reconcileFacts = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  sourceId: string
) => {
  const links = await tx.factSource.findMany({
    where: { orgId, sourceId },
    select: {
      factId: true,
      fact: { select: { status: true, publishedAt: true } },
    },
  });
  // Documents every member may use: only their words may become a fact's
  // evidence, since a published or typed fact is shown to everyone (audit H2).
  const companyWide =
    links.length > 0
      ? new Set(
          (
            await tx.$queryRawUnsafe<{ id: string }[]>(
              "select id from library.ai_source_ids($1, null, null, 'full') as id",
              orgId
            )
          ).map((r) => r.id)
        )
      : new Set<string>();
  for (const { factId, fact } of links) {
    const others = await tx.factSource.findMany({
      where: { orgId, factId, NOT: { sourceId } },
      orderBy: { createdAt: "asc" },
      select: {
        quote: true,
        sourceId: true,
        source: { select: { name: true } },
      },
    });
    const published = fact.publishedAt !== null;
    if (others.length > 0) {
      // Still stated by another document: its words become the evidence,
      // if everyone may read that document.
      const next = others.find((o) => o.quote && companyWide.has(o.sourceId));
      await tx.fact.update({
        where: { id: factId },
        data: {
          evidence: next ? `"${next.quote}" (${next.source.name})` : null,
          ...(published ? {} : { provenance: "source_deleted" }),
        },
      });
    } else if (
      !published &&
      (fact.status === "pending" || fact.status === "rejected")
    ) {
      await tx.fact.delete({ where: { id: factId } });
    } else {
      // Approved (or since replaced), or published: the value stays; the
      // words from the deleted document go.
      await tx.fact.update({
        where: { id: factId },
        data: { evidence: null, provenance: "source_deleted" },
      });
    }
  }
  await tx.factSource.deleteMany({ where: { orgId, sourceId } });
};

/** Delete stored files; true once storage confirms they're gone. */
const deleteFiles = async (row: {
  attempts: number;
  id: string;
  keys: string[];
  orgId: string;
  sourceId: string | null;
}) => {
  const store = objectStore();
  try {
    if (row.keys.length > 0) {
      if (!store) {
        throw new Error("Document storage isn't set up");
      }
      await store.remove(row.keys);
    }
    await database.storageDeletion.delete({ where: { id: row.id } });
  } catch (error) {
    const wait = Math.min(2 ** row.attempts, 360) * 60_000;
    await database.storageDeletion.updateMany({
      where: { id: row.id },
      data: {
        attempts: row.attempts + 1,
        lastError: String(error).slice(0, 300),
        nextAttemptAt: new Date(Date.now() + wait),
      },
    });
    log.warn("Deleting stored document files failed; will retry", {
      orgId: row.orgId,
      error: String(error),
    });
    return false;
  }
  if (row.sourceId) {
    const left = await database.storageDeletion.count({
      where: { orgId: row.orgId, sourceId: row.sourceId },
    });
    if (left === 0) {
      await audit({
        orgId: row.orgId,
        actorId: null,
        action: "purge_complete",
        sourceId: row.sourceId,
      });
    }
  }
  return true;
};

/** Stored files still waiting to be deleted, retried (the sweep); optionally one shop's. */
export const retryStorageDeletions = async (
  limit = 20,
  orgId: string | null = null
) => {
  const due = await database.storageDeletion.findMany({
    where: {
      nextAttemptAt: { lte: new Date() },
      ...(orgId ? { orgId } : {}),
    },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });
  let deleted = 0;
  for (const row of due) {
    deleted += (await deleteFiles(row)) ? 1 : 0;
  }
  return { due: due.length, deleted };
};

/** Files of a purged document still waiting; retried now. True when none are left. */
const finishFiles = async (orgId: string, sourceId: string) => {
  const pending = await database.storageDeletion.findMany({
    where: { orgId, sourceId },
  });
  let complete = true;
  for (const row of pending) {
    complete = (await deleteFiles(row)) && complete;
  }
  return complete;
};

/**
 * Permanently delete a document (no permission check: callers decide).
 * Safe to run again: a second call only retries the file deletion.
 */
export const purgeSource = async (
  orgId: string,
  sourceId: string,
  actorId: string | null
): Promise<{ complete: boolean }> => {
  await database.$transaction(
    async (tx) => {
      const [source] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `select id from "Source" where id = $1 and "orgId" = $2 for update`,
        sourceId,
        orgId
      );
      if (!source) {
        // Already gone: only its files may be left to delete.
        return;
      }
      const versions = await tx.documentVersion.findMany({
        where: { orgId, sourceId, storageKey: { not: null } },
        select: { storageKey: true },
      });
      const keys = [...new Set(versions.map((v) => v.storageKey as string))];
      await tx.storageDeletion.create({ data: { orgId, sourceId, keys } });
      await reconcileFacts(tx, orgId, sourceId);
      await tx.$executeRawUnsafe(
        REWRITE_MESSAGES_SQL,
        orgId,
        sourceId,
        `#source-${sourceId}`,
        REMOVED_ANSWER
      );
      await tx.messageSource.deleteMany({ where: { orgId, sourceId } });
      await tx.documentAuditLog.updateMany({
        where: { orgId, sourceId },
        data: { subjectName: null },
      });
      await audit(
        {
          orgId,
          actorId,
          action: "purge",
          sourceId,
          detail: { files: keys.length },
        },
        tx
      );
      // Versions, pages, passages (text and vectors) and grants go with it.
      await tx.source.delete({ where: { id: sourceId } });
    },
    { timeout: 30_000 }
  );
  return { complete: await finishFiles(orgId, sourceId) };
};

/**
 * Permanently delete a document from the Trash. Needs "manage" on it (the
 * owner, admins outside confidential folders). `complete: false` means its
 * stored files aren't confirmed deleted yet; the sweep keeps trying.
 */
export const purgeDocument = async (
  viewer: Viewer,
  sourceId: string
): Promise<Outcome<{ complete: boolean }>> => {
  const { orgId, userId, isAdmin, isOwner } = trustedViewer(viewer);
  const allowed = await authorizeDocument(viewer, sourceId, "manage", {
    trashed: true,
  });
  if (!allowed.ok) {
    // Already deleted with files still pending (asked again): an admin or
    // the owner can push the file deletion along.
    const leftover =
      allowed.status === 404 && (isAdmin || isOwner)
        ? await database.storageDeletion.count({ where: { orgId, sourceId } })
        : 0;
    if (leftover > 0) {
      return { ok: true, complete: await finishFiles(orgId, sourceId) };
    }
    return allowed;
  }
  if (!allowed.source.deletedAt) {
    return {
      ok: false,
      status: 409,
      error: "Move the document to the Trash before deleting it for good.",
    };
  }
  return { ok: true, ...(await purgeSource(orgId, sourceId, userId)) };
};
