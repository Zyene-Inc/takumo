import "server-only";

import { database } from "@repo/database";
import { type Capability, has } from "./capabilities";
import { trustedViewer, type Viewer } from "./viewer";

// The Knowledge Hub's access checks. Every decision is made by the library.*
// SQL functions (see the knowledge_hub_foundations migration); this module
// only calls them, with the shop, user and role of a viewer made on the
// server. The database works out departments and ownership itself. Nothing
// is cached: grants, departments and roles are read fresh for each check.

export interface Access {
  capabilities: number;
  /** Inside a confidential folder (HR, Finance…). */
  confidential: boolean;
}

export type Target = { folderId: string } | { sourceId: string };

const FOLDER_SQL = `
  select capabilities, confidential
  from library.folder_access($1, $2, $3)
  where folder_id = $4`;

const SOURCE_SQL = `
  select capabilities, confidential
  from library.source_access($1, $2, $3)
  where source_id = $4`;

const VISIBLE_SQL = `
  select id from library.visible_source_ids($1, $2, $3) as id`;

const args = (viewer: Viewer) => {
  const { orgId, userId, role } = trustedViewer(viewer);
  return [orgId, userId, role] as const;
};

/**
 * What the viewer may do with one folder or document of their shop; null when
 * it isn't in their shop (or isn't an uploaded document).
 */
export const accessTo = async (
  viewer: Viewer,
  target: Target
): Promise<Access | null> => {
  const [sql, id] =
    "folderId" in target
      ? [FOLDER_SQL, target.folderId]
      : [SOURCE_SQL, target.sourceId];
  const [row] = await database.$queryRawUnsafe<Access[]>(
    sql,
    ...args(viewer),
    id
  );
  return row ?? null;
};

/** IDs of the uploaded documents the viewer may view. */
export const visibleSourceIds = async (viewer: Viewer) =>
  (
    await database.$queryRawUnsafe<{ id: string }[]>(
      VISIBLE_SQL,
      ...args(viewer)
    )
  ).map((r) => r.id);

/**
 * For anything that acts on one folder or document: its access when the
 * viewer holds `capability`. Without view (and without it existing) the
 * answer is "not found", so guessing IDs tells nobody what exists; uploading
 * into a drop-box folder is the one thing that doesn't need view.
 */
export const requireCapability = async (
  viewer: Viewer,
  target: Target,
  capability: Capability
): Promise<
  { ok: true; access: Access } | { ok: false; reason: "not_found" | "denied" }
> => {
  const access = await accessTo(viewer, target);
  if (!access) {
    return { ok: false, reason: "not_found" };
  }
  const uploadOnly =
    capability === "upload" &&
    "folderId" in target &&
    has(access.capabilities, "upload");
  if (!(uploadOnly || has(access.capabilities, "view"))) {
    return { ok: false, reason: "not_found" };
  }
  return has(access.capabilities, capability)
    ? { ok: true, access }
    : { ok: false, reason: "denied" };
};
