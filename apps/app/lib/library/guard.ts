import "server-only";

import { can, type Permission } from "@repo/auth/permissions";
import { database } from "@repo/database";
import { DOCUMENT } from "../knowledge/documents";
import { requireCapability } from "./access";
import type { Capability } from "./capabilities";
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
