import "server-only";

import type { Prisma } from "@repo/database";
import { database } from "@repo/database";

// The document audit log: who did what to which document, and when. Entries
// hold ids, a file name (cleared on permanent delete) and small details such
// as a version number; never the document's text.

export type AuditAction =
  | "upload"
  | "version_upload"
  | "reread"
  | "processed"
  | "processing_failed"
  | "download"
  | "preview"
  | "trash"
  | "restore"
  | "purge"
  | "purge_complete";

export interface AuditEntry {
  action: AuditAction;
  /** WorkOS user; null for Takumo itself. */
  actorId: string | null;
  detail?: Record<string, string | number | boolean | null>;
  folderId?: string | null;
  orgId: string;
  sourceId?: string | null;
  subjectName?: string | null;
  versionId?: string | null;
}

type Client = Pick<Prisma.TransactionClient, "$executeRawUnsafe">;

// The document's name is kept only while the document exists. The lock
// waits for a permanent delete that is committing (it holds the document's
// row), after which the row is gone and no name is written; otherwise an
// entry written at that moment would keep a name the delete just cleared.
const AUDIT_SQL = `
  insert into "DocumentAuditLog"
    (id, "orgId", "actorId", action, "sourceId", "versionId", "folderId",
     "subjectName", detail, "createdAt")
  values (
    $1, $2, $3, $4, $5, $6, $7,
    (select $8::text from "Source" where id = $5 and "orgId" = $2 for key share),
    $9::jsonb, now()
  )`;

/** Record one event, inside the caller's transaction when given one. */
export const audit = (entry: AuditEntry, client: Client = database) =>
  client.$executeRawUnsafe(
    AUDIT_SQL,
    crypto.randomUUID(),
    entry.orgId,
    entry.actorId,
    entry.action,
    entry.sourceId ?? null,
    entry.versionId ?? null,
    entry.folderId ?? null,
    entry.subjectName?.slice(0, 300) ?? null,
    entry.detail ? JSON.stringify(entry.detail) : null
  );
