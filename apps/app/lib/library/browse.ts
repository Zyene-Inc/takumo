import "server-only";

import { can } from "@repo/auth/permissions";
import { database } from "@repo/database";
import { folderCapabilities } from "./access";
import { DEFAULT_FOLDERS, ensureDefaultFolders } from "./folders";
import { allows } from "./guard";
import { type DocumentRow, documentRows } from "./rows";
import { confidentialEnabled } from "./stage";
import { trustedViewer, type Viewer } from "./viewer";

// What the Company Knowledge Library shows: folders, the documents in them,
// My Uploads, Recent and the Trash. Every list is limited to what the viewer
// may view (library.folder_access / source_access).

export interface FolderCard {
  documents: number;
  folders: number;
  id: string;
  kind: string;
  name: string;
  systemKey: string | null;
}

export interface FolderView {
  /** Add documents here. */
  canAdd: boolean;
  /** Create subfolders; rename, move or delete this folder (not a default one). */
  canManage: boolean;
  documents: DocumentRow[];
  folder: {
    id: string;
    kind: string;
    name: string;
    parentId: string | null;
  } | null;
  folders: FolderCard[];
  /** From the top down to (not including) this folder. */
  trail: { id: string; name: string }[];
}

const DEFAULT_ORDER = new Map<string, number>(
  DEFAULT_FOLDERS.map((f, i) => [f.key, i])
);

const byDefaultThenName = (
  a: { name: string; systemKey: string | null },
  b: { name: string; systemKey: string | null }
) => {
  const ai = a.systemKey ? (DEFAULT_ORDER.get(a.systemKey) ?? 99) : 100;
  const bi = b.systemKey ? (DEFAULT_ORDER.get(b.systemKey) ?? 99) : 100;
  return ai - bi || a.name.localeCompare(b.name);
};

/** Folders the viewer may see, by id. */
const visibleFolders = async (viewer: Viewer) => {
  const { orgId, role } = trustedViewer(viewer);
  const [capabilities, restricted] = await Promise.all([
    folderCapabilities(viewer),
    confidentialEnabled(orgId),
  ]);
  return {
    capabilities,
    sees: (id: string) =>
      allows(capabilities.get(id) ?? 0, "view", role, restricted),
    may: (id: string, capability: "upload" | "edit") =>
      allows(capabilities.get(id) ?? 0, capability, role, restricted),
  };
};

/** Folders inside `parentId` (or at the top), with what's in each. */
const childFolders = async (viewer: Viewer, parentId: string | null) => {
  const { orgId } = trustedViewer(viewer);
  const { sees } = await visibleFolders(viewer);
  const rows = await database.folder.findMany({
    where: {
      orgId,
      parentId,
      kind: { in: ["normal", "system"] },
    },
    select: {
      id: true,
      name: true,
      kind: true,
      systemKey: true,
      _count: {
        select: {
          children: true,
          sources: { where: { deletedAt: null, profile: "document" } },
        },
      },
    },
  });
  return rows
    .filter((f) => sees(f.id))
    .sort(byDefaultThenName)
    .map((f) => ({
      id: f.id,
      name: f.name,
      kind: f.kind,
      systemKey: f.systemKey,
      folders: f._count.children,
      documents: f._count.sources,
    }));
};

/** The library's top-level folders, for its navigation (defaults first). */
export const libraryNav = async (viewer: Viewer) => {
  await ensureDefaultFolders(trustedViewer(viewer).orgId);
  return childFolders(viewer, null);
};

/**
 * A folder's contents (or the top level: folders and the documents outside
 * any folder). Null when the folder isn't in the viewer's shop or they may
 * not see it.
 */
export const folderView = async (
  viewer: Viewer,
  folderId: string | null
): Promise<FolderView | null> => {
  const { orgId, role, isAdmin, isOwner } = trustedViewer(viewer);
  const access = await visibleFolders(viewer);
  let folder: FolderView["folder"] = null;
  let trail: FolderView["trail"] = [];
  if (folderId) {
    const found = await database.folder.findFirst({
      where: { id: folderId, orgId, kind: { in: ["normal", "system"] } },
      select: { id: true, name: true, kind: true, parentId: true, path: true },
    });
    if (!(found && access.sees(found.id))) {
      return null;
    }
    folder = {
      id: found.id,
      name: found.name,
      kind: found.kind,
      parentId: found.parentId,
    };
    const ancestors = await database.folder.findMany({
      where: { orgId, id: { in: found.path.slice(0, -1) } },
      select: { id: true, name: true },
    });
    const byId = new Map(ancestors.map((a) => [a.id, a]));
    trail = found.path
      .slice(0, -1)
      .flatMap((id) =>
        byId.has(id) ? [byId.get(id) as (typeof ancestors)[0]] : []
      );
  }
  const [folders, documents] = await Promise.all([
    childFolders(viewer, folderId),
    documentRows(viewer, { folderId, deletedAt: null }),
  ]);
  const topLevelManager = isOwner || isAdmin || can(role, "knowledge:write");
  return {
    folder,
    trail,
    folders,
    documents,
    canAdd: folderId
      ? access.may(folderId, "upload")
      : can(role, "knowledge:share"),
    canManage: folderId ? access.may(folderId, "edit") : topLevelManager,
  };
};

/** Every folder the viewer may add documents to, with its full path (for "Move to"). */
export const folderChoices = async (viewer: Viewer) => {
  const { orgId } = trustedViewer(viewer);
  const access = await visibleFolders(viewer);
  const rows = await database.folder.findMany({
    where: { orgId, kind: { in: ["normal", "system"] } },
    select: { id: true, name: true, path: true },
  });
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return rows
    .filter((r) => access.may(r.id, "upload"))
    .map((r) => ({
      id: r.id,
      label: r.path.map((id) => names.get(id) ?? "…").join(" / "),
      path: r.path,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
};

/** Documents this person uploaded (a view, not a folder). */
export const myUploads = (viewer: Viewer) => {
  const { userId } = trustedViewer(viewer);
  if (!userId) {
    return Promise.resolve([]);
  }
  return documentRows(
    viewer,
    { uploadedBy: userId, deletedAt: null },
    { orderBy: { createdAt: "desc" } }
  );
};

/**
 * This person's uploads that Takumo moved to the Trash because it could never
 * read them (lib/library/lease.ts). Shown on My uploads: not everyone can
 * open the Trash, and the document shouldn't just disappear.
 */
export const unreadableUploads = (viewer: Viewer) => {
  const { userId } = trustedViewer(viewer);
  if (!userId) {
    return Promise.resolve([]);
  }
  return documentRows(
    viewer,
    {
      uploadedBy: userId,
      deletedAt: { not: null },
      deletedBy: null,
      currentVersionId: null,
    },
    { orderBy: { deletedAt: "desc" } }
  );
};

/** Documents added or changed most recently. */
export const recentDocuments = (viewer: Viewer) =>
  documentRows(
    viewer,
    { deletedAt: null },
    { orderBy: { updatedAt: "desc" }, take: 50 }
  );

/** Documents in the Trash the viewer may restore (or permanently delete). */
export const trashedDocuments = async (viewer: Viewer) =>
  (
    await documentRows(
      viewer,
      { deletedAt: { not: null } },
      { orderBy: { deletedAt: "desc" } }
    )
  ).filter((d) => d.canDelete || d.canPurge);
