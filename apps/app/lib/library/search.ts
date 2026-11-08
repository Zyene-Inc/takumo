import "server-only";

import { database } from "@repo/database";
import { DOCUMENT, keywordPassages } from "../knowledge/documents";
import { DOC_TYPE_LABEL } from "../knowledge/understand";
import { type DocumentRow, documentRows } from "./rows";
import { trustedViewer, type Viewer } from "./viewer";

// The library's search box: document names, folder names, document types
// (as Takumo read them) and the text of documents, with Postgres alone (no
// AI call, unlike Ask). Only documents of the viewer's shop that they may
// view, that aren't in the Trash and that have a version in use are found;
// text is only ever matched in that version.

export type MatchedBy = "name" | "type" | "folder" | "text";

export interface SearchResult {
  document: DocumentRow;
  matchedBy: MatchedBy;
  /** A passage with the matched words between « », for text matches. */
  snippet: string | null;
}

export const MIN_QUERY = 2;
const MAX_QUERY = 200;
const LIMIT = 50;

// Live documents whose current version Takumo read as one of these types.
const BY_TYPE_SQL = `
  select c."sourceId" as id
  from "DocChunk" c
  join "Source" s on s.id = c."sourceId"
  where c."orgId" = $1 and c.ordinal = 0
    and c."versionId" = s."currentVersionId" and s."deletedAt" is null
    and c.meta ->> 'docType' = any($2::text[])
    and c."sourceId" in (select library.visible_source_ids($1, $3, $4))
  limit 200`;

/** Document types whose label contains the query ("sop", "drawing"…). */
const typesMatching = (query: string) => {
  const q = query.toLowerCase();
  return Object.entries(DOC_TYPE_LABEL)
    .filter(([key, label]) => label.toLowerCase().includes(q) || key === q)
    .map(([key]) => key);
};

export const searchLibrary = async (
  viewer: Viewer,
  raw: string
): Promise<SearchResult[]> => {
  const { orgId, userId, role } = trustedViewer(viewer);
  const query = raw.trim().slice(0, MAX_QUERY);
  if (query.length < MIN_QUERY) {
    return [];
  }
  const types = typesMatching(query);
  const [named, inFolders, typed, passages] = await Promise.all([
    database.source.findMany({
      where: {
        orgId,
        deletedAt: null,
        ...DOCUMENT,
        name: { contains: query, mode: "insensitive" },
      },
      select: { id: true },
      take: 200,
    }),
    database.source.findMany({
      where: {
        orgId,
        deletedAt: null,
        ...DOCUMENT,
        folder: { name: { contains: query, mode: "insensitive" } },
      },
      select: { id: true },
      take: 200,
    }),
    types.length
      ? database.$queryRawUnsafe<{ id: string }[]>(
          BY_TYPE_SQL,
          orgId,
          types,
          userId,
          role
        )
      : [],
    keywordPassages(viewer, query, 60),
  ]);
  // Best reason first: its name, then its type, its folder, then its text.
  const reasons = new Map<string, { by: MatchedBy; snippet: string | null }>();
  const note = (id: string, by: MatchedBy, snippet: string | null = null) => {
    if (!reasons.has(id)) {
      reasons.set(id, { by, snippet });
    }
  };
  for (const { id } of named) {
    note(id, "name");
  }
  for (const { id } of typed) {
    note(id, "type");
  }
  for (const { id } of inFolders) {
    note(id, "folder");
  }
  for (const p of passages) {
    note(p.sourceId, "text", p.snippet);
  }
  const order = [...reasons.keys()];
  const rows = await documentRows(viewer, {
    id: { in: order },
    deletedAt: null,
    // A document still being read for the first time has nothing to find.
    currentVersionId: { not: null },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return order
    .flatMap((id) => {
      const document = byId.get(id);
      const reason = reasons.get(id);
      return document && reason
        ? [{ document, matchedBy: reason.by, snippet: reason.snippet }]
        : [];
    })
    .slice(0, LIMIT);
};
