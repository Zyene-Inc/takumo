import "server-only";

import { database } from "@repo/database";
import { trustedViewer, type Viewer } from "./viewer";

// What a person's questions to Takumo may draw on. The library.* SQL
// functions decide (see the knowledge_hub_secure_memory migration); this
// module only calls them, with a viewer made on the server. Nothing is
// cached: every call reads grants, departments, the Trash and folder AI
// settings as they are now.

/**
 * How far a document's AI setting must allow: "search" for its passages
 * found by keywords, "full" for vectors, facts and the Brain.
 */
export type AiUse = "search" | "full";

const args = (viewer: Viewer) => {
  const { orgId, userId, role } = trustedViewer(viewer);
  return [orgId, userId, role] as const;
};

/**
 * SQL that lists the documents a viewer may use, for `"sourceId" in (…)`.
 * $1 must be the shop; the user, role and use go in the given positions.
 */
export const usableSourcesSql = (user: number, role: number, use: number) =>
  `select library.ai_source_ids($1, $${user}, $${role}, $${use})`;

/** The parameters usableSourcesSql expects after $1 (the shop). */
export const usableSourcesArgs = (viewer: Viewer, use: AiUse) => {
  const [, userId, role] = args(viewer);
  return [userId, role, use] as const;
};

/** IDs of the documents the viewer may use for `use`. */
export const usableSourceIds = async (viewer: Viewer, use: AiUse) =>
  new Set(
    (
      await database.$queryRawUnsafe<{ id: string }[]>(
        "select library.ai_source_ids($1, $2, $3, $4) as id",
        ...args(viewer),
        use
      )
    ).map((r) => r.id)
  );

export interface FactAccess {
  /** Its words from documents may be shown to this viewer. */
  evidence: boolean;
}

/** The facts the viewer may see (by id), and whether their quotes may be shown. */
export const factAccess = async (viewer: Viewer) =>
  new Map(
    (
      await database.$queryRawUnsafe<{ evidence: boolean; fact_id: string }[]>(
        "select fact_id, evidence from library.fact_access($1, $2, $3)",
        ...args(viewer)
      )
    ).map((r) => [r.fact_id, { evidence: r.evidence } satisfies FactAccess])
  );

/** IDs of the facts the viewer may see, for `id: { in: … }` filters. */
export const visibleFactIds = async (viewer: Viewer) => [
  ...(await factAccess(viewer)).keys(),
];
