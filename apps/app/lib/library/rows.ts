import "server-only";

import { listShopMembers } from "@repo/auth/server";
import { database, type Prisma } from "@repo/database";
import { log } from "@repo/observability/log";
import { DOC_TYPE_LABEL } from "../knowledge/understand";
import { documentCapabilities, folderCapabilities } from "./access";
import { allows } from "./guard";
import { confidentialEnabled } from "./stage";
import { trustedViewer, type Viewer } from "./viewer";

// Documents as the library lists them: one row per document (never per
// version), with the state its newest version is really in, who uploaded it
// and what the viewer may do with it. Only documents the viewer may view
// (library.source_access) are ever returned.

export type DocumentState =
  | "uploading"
  | "queued"
  | "processing"
  | "ready"
  | "failed";

export interface DocumentRow {
  canDelete: boolean;
  canEdit: boolean;
  /** Permanently delete (owner, admins outside confidential folders). */
  canPurge: boolean;
  createdAt: Date;
  /** Version in use; null while the first one is still being read (or failed). */
  current: {
    mimeType: string | null;
    number: number;
    originalKept: boolean;
    size: number | null;
  } | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  /** What Takumo read the document as (SOP, drawing…), when it has. */
  docType: string | null;
  folder: { id: string; name: string } | null;
  id: string;
  name: string;
  /** Who deleted it, for the Trash. */
  removerName: string | null;
  state: DocumentState;
  /** The state is about a new version; the current one stays in use. */
  stateIsNewVersion: boolean;
  updatedAt: Date;
  uploadedBy: string | null;
  uploaderName: string;
}

const IN_FLIGHT = new Set(["uploading", "queued", "processing"]);

export const ROW_SELECT = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  deletedBy: true,
  uploadedBy: true,
  folder: { select: { id: true, name: true } },
  currentVersion: {
    select: {
      id: true,
      number: true,
      mimeType: true,
      size: true,
      originalKept: true,
    },
  },
  versions: {
    orderBy: { number: "desc" },
    take: 1,
    select: { id: true, status: true },
  },
} satisfies Prisma.SourceSelect;

type Selected = Prisma.SourceGetPayload<{ select: typeof ROW_SELECT }>;

/** The state the library shows: a new version in progress or failed wins. */
export const stateOf = (
  current: { id: string } | null,
  latest: { id: string; status: string } | undefined
): { state: DocumentState; stateIsNewVersion: boolean } => {
  const newer = latest && latest.id !== current?.id ? latest : null;
  if (newer && (IN_FLIGHT.has(newer.status) || newer.status === "failed")) {
    return {
      state: newer.status as DocumentState,
      stateIsNewVersion: current !== null,
    };
  }
  if (current) {
    return { state: "ready", stateIsNewVersion: false };
  }
  const status = latest?.status ?? "failed";
  return {
    state: (IN_FLIGHT.has(status) ? status : "failed") as DocumentState,
    stateIsNewVersion: false,
  };
};

/** Shop members' names by WorkOS user id (empty when WorkOS can't be reached). */
export const memberNames = async (orgId: string) => {
  try {
    return new Map(
      (await listShopMembers(orgId)).map((m) => [m.userId, m.name])
    );
  } catch (error) {
    log.warn("Couldn't list shop members for the library", {
      error: String(error),
    });
    return new Map<string, string>();
  }
};

/** How the library names a person: never a raw id, never a guess. */
export const personName = (
  names: Map<string, string>,
  userId: string | null,
  unknown = "Not recorded"
) => {
  if (!userId) {
    return unknown;
  }
  return names.get(userId) ?? "Former member";
};

/** What Takumo read each current version as (from its card passage). */
const docTypes = async (orgId: string, versionIds: string[]) => {
  if (versionIds.length === 0) {
    return new Map<string, string>();
  }
  const cards = await database.docChunk.findMany({
    where: { orgId, versionId: { in: versionIds }, ordinal: 0 },
    select: { versionId: true, meta: true },
  });
  const types = new Map<string, string>();
  for (const card of cards) {
    const docType = (card.meta as { docType?: string } | null)?.docType;
    // "other" reads as "document": it says nothing, so nothing is shown.
    const label =
      docType && docType !== "other"
        ? DOC_TYPE_LABEL[docType as keyof typeof DOC_TYPE_LABEL]
        : null;
    if (card.versionId && label) {
      types.set(card.versionId, label);
    }
  }
  return types;
};

/**
 * Rows for the documents matching `where` that the viewer may view, in the
 * order asked for. `where` is always narrowed to this shop's documents.
 */
export const documentRows = async (
  viewer: Viewer,
  where: Prisma.SourceWhereInput,
  {
    orderBy = { name: "asc" },
    take,
  }: {
    orderBy?: Prisma.SourceOrderByWithRelationInput;
    take?: number;
  } = {}
): Promise<DocumentRow[]> => {
  const { orgId, role } = trustedViewer(viewer);
  const [capabilities, folderCaps, restricted] = await Promise.all([
    documentCapabilities(viewer),
    folderCapabilities(viewer),
    confidentialEnabled(orgId),
  ]);
  const found: Selected[] = await database.source.findMany({
    where: { ...where, orgId, type: "upload", profile: "document" },
    orderBy,
    select: ROW_SELECT,
    ...(take ? { take: take * 2 } : {}),
  });
  const visible = found
    .filter((s) =>
      allows(capabilities.get(s.id) ?? 0, "view", role, restricted)
    )
    .slice(0, take);
  const [names, types] = await Promise.all([
    memberNames(orgId),
    docTypes(
      orgId,
      visible.flatMap((s) => (s.currentVersion ? [s.currentVersion.id] : []))
    ),
  ]);
  return visible.map((s) => {
    const caps = capabilities.get(s.id) ?? 0;
    const { id: currentId, ...current } = s.currentVersion ?? { id: "" };
    return {
      id: s.id,
      name: s.name,
      // A folder the viewer can't open isn't named, even to someone given
      // a document inside it (audit G3-F4).
      folder:
        s.folder &&
        allows(folderCaps.get(s.folder.id) ?? 0, "view", role, restricted)
          ? s.folder
          : null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      deletedAt: s.deletedAt,
      deletedBy: s.deletedBy,
      uploadedBy: s.uploadedBy,
      uploaderName: personName(names, s.uploadedBy),
      removerName: s.deletedAt
        ? personName(names, s.deletedBy, "Takumo")
        : null,
      current: s.currentVersion
        ? (current as NonNullable<DocumentRow["current"]>)
        : null,
      docType: currentId ? (types.get(currentId) ?? null) : null,
      ...stateOf(s.currentVersion, s.versions[0]),
      canEdit: allows(caps, "edit", role, restricted),
      canDelete: allows(caps, "delete", role, restricted),
      canPurge: allows(caps, "manage", role, false),
    };
  });
};
