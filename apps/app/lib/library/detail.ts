import "server-only";

import { database } from "@repo/database";
import { isCard } from "../knowledge/documents";
import { DOC_TYPE_LABEL } from "../knowledge/understand";
import { documentCapabilities } from "./access";
import type { AuditAction } from "./audit";
import { allows, authorizeDocument } from "./guard";
import {
  type DocumentRow,
  documentRows,
  memberNames,
  personName,
} from "./rows";
import { confidentialEnabled } from "./stage";
import { trustedViewer, type Viewer } from "./viewer";

// One document's page in the library: its details, every version, what has
// happened to it, and the text Takumo read from it. Version errors are the
// messages written for people when processing failed (never a provider's).

export type VersionLabel =
  | "active"
  | "previous"
  | "replaced"
  | "uploading"
  | "queued"
  | "processing"
  | "failed";

export interface VersionRow {
  canRetry: boolean;
  createdAt: Date;
  /** Written for people (lib/library/process.ts). */
  error: string | null;
  id: string;
  label: VersionLabel;
  mimeType: string | null;
  name: string;
  number: number;
  /** False for documents added before originals were kept: nothing to download. */
  originalKept: boolean;
  size: number | null;
  uploaderName: string;
}

export interface Activity {
  at: Date;
  id: string;
  text: string;
}

export interface LinkedRecord {
  href: string;
  label: string;
}

export interface DocumentDetail {
  activity: Activity[];
  classification: string | null;
  document: DocumentRow;
  linked: LinkedRecord[];
  /** The current version's original file name. */
  originalName: string | null;
  summary: string | null;
  /** The text Takumo read (current version), shortened; null when none. */
  text: { content: string; truncated: boolean } | null;
  trail: { id: string; name: string }[];
  versions: VersionRow[];
}

const TEXT_PREVIEW_CHARS = 20_000;

const labelOf = (
  version: { id: string; status: string },
  currentId: string | null
): VersionLabel => {
  if (version.id === currentId) {
    return "active";
  }
  switch (version.status) {
    case "ready":
      return "previous";
    case "superseded":
      return "replaced";
    case "uploading":
    case "queued":
    case "processing":
    case "failed":
      return version.status;
    default:
      return "failed";
  }
};

const enc = encodeURIComponent;

/** Where a record the document is about lives in Takumo. */
const recordHref = (ref: string, label: string) => {
  const [type, id] = ref.split(":");
  switch (type) {
    case "part":
      return `/shop/parts/${enc(id ?? "")}`;
    case "machine":
      return `/shop/work-centers?q=${enc(label)}`;
    case "customer":
      return `/shop/customers?q=${enc(label)}`;
    case "material":
      return `/shop/materials?q=${enc(label)}`;
    default:
      return null;
  }
};

const ACTION_TEXT: Record<AuditAction, string> = {
  upload: "uploaded it",
  version_upload: "uploaded a new version",
  reread: "had Takumo read it again",
  processed: "Takumo finished reading it",
  processing_failed: "Takumo couldn't read a version",
  download: "downloaded it",
  preview: "opened it",
  trash: "moved it to the Trash",
  restore: "restored it from the Trash",
  purge: "deleted it permanently",
  purge_complete: "its stored files were deleted",
  move: "moved it to another folder",
  folder_create: "created a folder",
  folder_rename: "renamed a folder",
  folder_move: "moved a folder",
  folder_delete: "deleted a folder",
};

/** An audit entry as a sentence, without technical details. */
const activityText = (
  entry: { action: string; actorId: string | null; detail: unknown },
  names: Map<string, string>
) => {
  const what = ACTION_TEXT[entry.action as AuditAction] ?? "changed it";
  const version = (entry.detail as { version?: unknown } | null)?.version;
  const suffix =
    typeof version === "number" && entry.action !== "upload"
      ? ` (version ${version})`
      : "";
  if (!entry.actorId) {
    // Takumo's own steps read as they are; anything else was Takumo too.
    const own = what.startsWith("Takumo") || what.startsWith("its ");
    return `${own ? what.charAt(0).toUpperCase() + what.slice(1) : `Takumo ${what}`}${suffix}`;
  }
  return `${personName(names, entry.actorId)} ${what}${suffix}`;
};

/** The current version's text: its saved pages, or (older documents) its passages. */
const readText = async (orgId: string, sourceId: string, versionId: string) => {
  const pages = await database.documentPage.findMany({
    where: { orgId, versionId },
    orderBy: { position: "asc" },
    select: { text: true },
  });
  const parts = pages.length
    ? pages.map((p) => p.text)
    : (
        await database.docChunk.findMany({
          where: { orgId, sourceId, versionId },
          orderBy: { ordinal: "asc" },
          select: { content: true, meta: true },
        })
      )
        // The card is Takumo's summary, not the document's text.
        .filter((c) => !isCard(c.meta))
        .map((c) => c.content);
  const content = parts.join("\n\n").trim();
  if (!content) {
    return null;
  }
  return {
    content: content.slice(0, TEXT_PREVIEW_CHARS),
    truncated: content.length > TEXT_PREVIEW_CHARS,
  };
};

interface CardMeta {
  docType?: string;
  links?: { label: string; ref: string }[];
  revision?: string | null;
}

/**
 * Everything the document's page shows; null when it isn't in the viewer's
 * shop or they may not view it. Documents in the Trash are included.
 */
export const documentDetail = async (
  viewer: Viewer,
  sourceId: string
): Promise<DocumentDetail | null> => {
  const { orgId, userId, role } = trustedViewer(viewer);
  const allowed = await authorizeDocument(viewer, sourceId, "view", {
    trashed: true,
  });
  if (!allowed.ok) {
    return null;
  }
  const [rows, source, versions, audits, names, caps, restricted] =
    await Promise.all([
      documentRows(viewer, { id: sourceId }),
      database.source.findUniqueOrThrow({
        where: { id: sourceId },
        select: {
          summary: true,
          currentVersionId: true,
          currentVersion: { select: { name: true } },
          folder: { select: { path: true } },
        },
      }),
      database.documentVersion.findMany({
        where: { orgId, sourceId },
        orderBy: { number: "desc" },
        select: {
          id: true,
          number: true,
          name: true,
          status: true,
          error: true,
          size: true,
          mimeType: true,
          originalKept: true,
          uploadedBy: true,
          createdAt: true,
        },
      }),
      // Opening it isn't a change: every visit to its page previews the
      // file, which would bury what happened. Those stay in the audit log.
      database.documentAuditLog.findMany({
        where: { orgId, sourceId, action: { not: "preview" } },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          action: true,
          actorId: true,
          detail: true,
          createdAt: true,
        },
      }),
      memberNames(orgId),
      documentCapabilities(viewer),
      confidentialEnabled(orgId),
    ]);
  const [document] = rows;
  if (!document) {
    return null;
  }
  const canEdit = allows(caps.get(sourceId) ?? 0, "edit", role, restricted);
  const [card, ancestors, text] = await Promise.all([
    source.currentVersionId
      ? database.docChunk.findFirst({
          where: { orgId, versionId: source.currentVersionId, ordinal: 0 },
          select: { meta: true },
        })
      : null,
    source.folder
      ? database.folder.findMany({
          where: { orgId, id: { in: source.folder.path } },
          select: { id: true, name: true },
        })
      : [],
    source.currentVersionId
      ? readText(orgId, sourceId, source.currentVersionId)
      : null,
  ]);
  const meta = (card?.meta ?? {}) as CardMeta;
  // "other" reads as "document": it says nothing, so nothing is shown.
  const type =
    meta.docType && meta.docType !== "other"
      ? DOC_TYPE_LABEL[meta.docType as keyof typeof DOC_TYPE_LABEL]
      : null;
  const byId = new Map(ancestors.map((a) => [a.id, a]));
  return {
    document,
    summary: source.summary,
    originalName: source.currentVersion?.name ?? null,
    classification: type
      ? `${type.charAt(0).toUpperCase()}${type.slice(1)}${meta.revision ? `, rev ${meta.revision}` : ""}`
      : null,
    linked: (meta.links ?? []).flatMap((l) => {
      const href = recordHref(l.ref, l.label);
      return href ? [{ href, label: l.label }] : [];
    }),
    trail: (source.folder?.path ?? []).flatMap((id) =>
      byId.has(id) ? [byId.get(id) as (typeof ancestors)[0]] : []
    ),
    text,
    versions: versions.map((v) => ({
      id: v.id,
      number: v.number,
      name: v.name,
      label: labelOf(v, source.currentVersionId),
      error: v.status === "failed" ? v.error : null,
      size: v.size,
      mimeType: v.mimeType,
      originalKept: v.originalKept,
      createdAt: v.createdAt,
      uploaderName: personName(names, v.uploadedBy),
      canRetry:
        v.status === "failed" &&
        (canEdit || Boolean(userId && v.uploadedBy === userId)),
    })),
    activity: audits.map((a) => ({
      id: a.id,
      at: a.createdAt,
      text: activityText(a, names),
    })),
  };
};
