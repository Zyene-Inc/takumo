import "server-only";

import { can, type Permission } from "@repo/auth/permissions";
import { database } from "@repo/database";
import { DOCUMENT } from "../knowledge/documents";
import { requireCapability } from "./access";
import { type Capability, has } from "./capabilities";
import { confidentialEnabled } from "./stage";
import { trustedViewer, type Viewer } from "./viewer";

// Whether a viewer may do something with one document. The Knowledge Hub's
// capabilities decide (library.* SQL, via requireCapability). While
// restricted access is off (stage.ts) every document is company-wide, so the
// roles that change documents today keep doing so: editing and deleting
// need knowledge:write, as before. Once a shop restricts access, only the
// capabilities count.

const ROLE_RULE: Partial<Record<Capability, Permission>> = {
  edit: "knowledge:write",
  delete: "knowledge:write",
};

/**
 * The same decision as authorizeDocument, from capabilities already read:
 * whether `capabilities` (and, while restricted access is off, the viewer's
 * role) allow `capability`. For lists, where one query reads every row's
 * capabilities.
 */
export const allows = (
  capabilities: number,
  capability: Capability,
  role: string | null,
  restricted: boolean
) => {
  if (!has(capabilities, "view")) {
    return false;
  }
  if (has(capabilities, capability)) {
    return true;
  }
  const rule = ROLE_RULE[capability];
  return Boolean(rule && can(role, rule) && !restricted);
};

export interface GuardedDocument {
  currentVersionId: string | null;
  deletedAt: Date | null;
  folderId: string | null;
  id: string;
  name: string;
}

export type DocumentDecision =
  | { ok: true; source: GuardedDocument }
  | { ok: false; status: 403 | 404; error: string };

const NOT_FOUND = {
  ok: false,
  status: 404,
  error: "That document doesn't exist.",
} as const;

/**
 * The document, when it's in the viewer's shop and they may do `capability`
 * with it. Not visible (or not in their shop): 404, so ids reveal nothing.
 * Documents in the Trash count only with `trashed`.
 */
export const authorizeDocument = async (
  viewer: Viewer,
  sourceId: string,
  capability: Capability,
  { trashed = false }: { trashed?: boolean } = {}
): Promise<DocumentDecision> => {
  const { orgId, role } = trustedViewer(viewer);
  const source = await database.source.findFirst({
    where: { id: sourceId, orgId, ...DOCUMENT },
    select: {
      id: true,
      name: true,
      folderId: true,
      deletedAt: true,
      currentVersionId: true,
    },
  });
  if (!source || (source.deletedAt && !trashed)) {
    return NOT_FOUND;
  }
  const decision = await requireCapability(viewer, { sourceId }, capability);
  if (decision.ok) {
    return { ok: true, source };
  }
  if (decision.reason === "not_found") {
    return NOT_FOUND;
  }
  const rule = ROLE_RULE[capability];
  if (rule && can(role, rule) && !(await confidentialEnabled(orgId))) {
    return { ok: true, source };
  }
  return {
    ok: false,
    status: 403,
    error: "You don't have permission to do that with this document.",
  };
};

export interface GuardedFolder {
  depth: number;
  id: string;
  kind: string;
  name: string;
  parentId: string | null;
  path: string[];
  systemKey: string | null;
}

export type FolderDecision =
  | { ok: true; folder: GuardedFolder }
  | { ok: false; status: 403 | 404; error: string };

const NO_FOLDER = {
  ok: false,
  status: 404,
  error: "That folder doesn't exist.",
} as const;

/**
 * The folder, when it's in the viewer's shop and they may do `capability`
 * with it (the same rules as documents). Not visible: 404.
 */
export const authorizeFolder = async (
  viewer: Viewer,
  folderId: string,
  capability: Capability
): Promise<FolderDecision> => {
  const { orgId, role } = trustedViewer(viewer);
  const folder = await database.folder.findFirst({
    where: { id: folderId, orgId },
    select: {
      id: true,
      name: true,
      parentId: true,
      kind: true,
      systemKey: true,
      depth: true,
      path: true,
    },
  });
  if (!folder) {
    return NO_FOLDER;
  }
  const decision = await requireCapability(viewer, { folderId }, capability);
  if (decision.ok) {
    return { ok: true, folder };
  }
  if (decision.reason === "not_found") {
    return NO_FOLDER;
  }
  const rule = ROLE_RULE[capability];
  if (rule && can(role, rule) && !(await confidentialEnabled(orgId))) {
    return { ok: true, folder };
  }
  return {
    ok: false,
    status: 403,
    error: "You don't have permission to change this folder.",
  };
};
