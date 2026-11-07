import "server-only";

import { embed, embedMany } from "@repo/ai";
import { canEmbed, embeddingOptions, models } from "@repo/ai/lib/models";
import { database, forOrg } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  chunkPages,
  cleanSnippet,
  type PageText,
  plainSummary,
  searchTerms,
} from "./chunk";

const FILE_EXTENSION = /\.(pdf|docx|txt|md|csv)$/i;
const BRACKETS = /[[\]]/g;
const SPACES = /\s+/g;

/** Display name: no file extension, no square brackets (they'd break [doc …] citations). */
export const cleanName = (fileName: string) =>
  fileName
    .replace(FILE_EXTENSION, "")
    .replace(BRACKETS, "")
    .replace(SPACES, " ")
    .trim()
    .slice(0, 160) || "Untitled";

const vectorLiteral = (values: number[]) => `[${values.join(",")}]`;

// Uploaded documents, as opposed to spreadsheet imports or ERP reports.
export const DOCUMENT = { type: "upload", profile: "document" } as const;

/**
 * The live document (not in the Trash) a file of this name would clash with,
 * if any. Matches by the cleaned name, so "SOP.pdf" and "SOP.docx" both find
 * "SOP".
 */
export const documentNamed = (orgId: string, fileName: string) =>
  forOrg(database, orgId).source.findFirst({
    where: {
      name: cleanName(fileName),
      folderId: null,
      deletedAt: null,
      ...DOCUMENT,
    },
    select: { id: true, name: true },
  });

/**
 * Thrown when a live document already has this name. Uploading never
 * replaces a document: a new version is its own, explicit action. The
 * message is written for people.
 */
export class DocumentExistsError extends Error {
  constructor(name: string) {
    super(
      `There's already a document called ${name}. Rename your file and upload it again.`
    );
    this.name = "DocumentExistsError";
  }
}

/** Store a document's chunks. Re-uploading a file with the same name replaces it. */
interface StoredChunk {
  content: string;
  /** One sentence placing the passage in its document, indexed with it. */
  context?: string;
  heading: string | null;
  /** Extra fields kept with the passage (records it mentions, card data). */
  meta?: Record<string, unknown>;
  page: number | null;
}

/** Vectors for the passages, or null when there's no embedding model or it fails. */
const embedChunks = async (chunks: StoredChunk[]) => {
  if (!canEmbed) {
    return null;
  }
  try {
    const { embeddings } = await embedMany({
      model: models.embeddings,
      // The context sentence goes into the vector too.
      values: chunks.map((c) =>
        c.context ? `${c.context}\n\n${c.content}` : c.content
      ),
      ...embeddingOptions("document"),
    });
    return embeddings.map(vectorLiteral);
  } catch (error) {
    // Keyword search still works without vectors.
    log.warn("Embedding failed; document is keyword-searchable only", {
      error: String(error),
    });
    return null;
  }
};

// One statement for every passage's vector (in order), so the transaction
// stays short.
const SET_VERSION_EMBEDDINGS_SQL = `
  update "DocChunk" c set embedding = v.embedding::vector
  from unnest($2::text[]) with ordinality as v(embedding, n)
  where c."versionId" = $1 and c.ordinal = v.n - 1 and c."orgId" = $3`;

// Holds other stores of the same document name in this shop until this one
// commits, so two uploads can't both pass the name check. The lock key and
// the lookup use the same shop and the same cleaned name (callers pass
// cleanName's result or a stored name), so "SOP.pdf" and "SOP.docx" queue on
// one lock. A unique index on live names backs it up.
export const LOCK_NAME_SQL =
  "select pg_advisory_xact_lock(hashtextextended($1, 0))";
export const nameLock = (orgId: string, name: string) =>
  `knowledge-document:${orgId}:${name}`;

// Long enough for a few hundred passages; nothing slow runs inside it.
const STORE_TIMEOUT_MS = 30_000;

/**
 * Store a whole document at once, as a new version that is current straight
 * away: for text Takumo writes itself (the demo shop, evaluations), which
 * needs no reading. Uploads go through the library's processing instead.
 *
 * Everything is written in one transaction, so the document is never seen
 * half-written. With `mayReplace` (Takumo's own sample documents only) an
 * existing document of this name gets the new version and keeps its id;
 * without it DocumentExistsError is thrown. When embedding fails the
 * document is still stored, searchable by keyword.
 */
export const storeDocument = async (
  orgId: string,
  name: string,
  summary: string,
  chunks: StoredChunk[],
  { mayReplace }: { mayReplace: boolean }
) => {
  // Before the transaction: it calls the embedding model.
  const vectors = await embedChunks(chunks);
  const versionId = crypto.randomUUID();

  const sourceId = await forOrg(database, orgId).$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(LOCK_NAME_SQL, nameLock(orgId, name));
      const existing = await tx.source.findFirst({
        where: { orgId, name, folderId: null, deletedAt: null, ...DOCUMENT },
        select: { id: true },
      });
      if (existing && !mayReplace) {
        throw new DocumentExistsError(name);
      }
      const id = existing?.id ?? crypto.randomUUID();
      if (!existing) {
        await tx.source.create({
          data: { id, orgId, name, ...DOCUMENT, status: "processing" },
        });
      }
      const [{ number }] = await tx.$queryRawUnsafe<{ number: number }[]>(
        `update "Source" set "versionSeq" = "versionSeq" + 1 where id = $1
         returning "versionSeq" as number`,
        id
      );
      await tx.documentVersion.create({
        data: {
          id: versionId,
          orgId,
          sourceId: id,
          number,
          name,
          status: "ready",
          stage: "done",
          activatedAt: new Date(),
        },
      });
      await tx.docChunk.createMany({
        data: chunks.map((c, ordinal) => ({
          id: crypto.randomUUID(),
          orgId,
          sourceId: id,
          versionId,
          ordinal,
          content: c.content,
          page: c.page,
          meta: {
            ...(c.heading ? { heading: c.heading } : {}),
            ...(c.context ? { context: c.context } : {}),
            ...c.meta,
          },
        })),
      });
      if (vectors) {
        await tx.$executeRawUnsafe(
          SET_VERSION_EMBEDDINGS_SQL,
          versionId,
          vectors,
          orgId
        );
      }
      await tx.source.update({
        where: { id },
        data: { currentVersionId: versionId, status: "ready", summary },
      });
      // Earlier versions' passages are never searched again.
      await tx.docChunk.deleteMany({
        where: {
          orgId,
          sourceId: id,
          OR: [{ versionId: null }, { NOT: { versionId } }],
        },
      });
      return id;
    },
    { timeout: STORE_TIMEOUT_MS }
  );
  return {
    sourceId,
    versionId,
    name,
    chunks: chunks.length,
    embedded: vectors !== null,
  };
};

/**
 * Store plain text as a document, without reading it (the demo shop, evals).
 * Replaces a document with the same name, as before.
 */
export const saveDocument = (
  orgId: string,
  rawName: string,
  pages: PageText[]
) => {
  const chunks = chunkPages(pages);
  if (chunks.length === 0) {
    throw new Error(
      "No text found. If it's a scanned PDF, it needs text recognition (OCR) first."
    );
  }
  return storeDocument(
    orgId,
    cleanName(rawName),
    plainSummary(chunks[0].content),
    chunks,
    { mayReplace: true }
  );
};

interface DocHit {
  chunkId: string;
  heading: string | null;
  page: number | null;
  score: number;
  snippet: string;
  sourceId: string;
  sourceName: string;
}

interface Row {
  heading: string | null;
  id: string;
  name: string;
  page: number | null;
  rank: number;
  snippet: string;
  sourceId: string;
}

// Only the current version of a document that isn't in the Trash is ever
// searched: a version still being read, a failed one and an older one are
// not.
const LIVE = `s."deletedAt" is null and c."versionId" = s."currentVersionId"`;

// What keyword search reads: the passage with its context sentence.
const SEARCHED = `coalesce(c.meta ->> 'context', '') || ' ' || c.content`;

// English stemming finds "deburring" for "deburr"; the 'simple' dictionary,
// used only for words with a digit, keeps codes whole, so "P-2001" or
// "AMS-2700" match exactly.
const KEYWORD_SQL = `
  with q as (
    -- Stop words are empty in English but not in 'simple': skip empties
    -- per dictionary, or the joined query wouldn't parse.
    select (string_agg(t.q::text, ' | ') filter (where t.q::text <> ''))::tsquery as query,
           (string_agg(t.s::text, ' | ') filter (where t.s::text <> ''))::tsquery as exact
    from (
      select plainto_tsquery('english', w) as q,
             plainto_tsquery('simple', case when w ~ '[0-9]' then w else '' end) as s
      from unnest($2::text[]) w
    ) t
  )
  select c.id, c."sourceId", s.name, c.page, c.meta ->> 'heading' as heading,
         coalesce(ts_rank_cd(to_tsvector('english', ${SEARCHED}), q.query), 0)
           + coalesce(ts_rank_cd(to_tsvector('simple', ${SEARCHED}), q.exact), 0) as rank,
         ts_headline('english', c.content, q.query,
           'StartSel=«, StopSel=», MaxWords=70, MinWords=30, MaxFragments=2, FragmentDelimiter=" … "') as snippet
  from "DocChunk" c
  join "Source" s on s.id = c."sourceId"
  cross join q
  where c."orgId" = $1
    and ${LIVE}
    and (to_tsvector('english', ${SEARCHED}) @@ q.query
      or to_tsvector('simple', ${SEARCHED}) @@ q.exact)
  order by rank desc
  limit $3`;

const VECTOR_SQL = `
  select c.id, c."sourceId", s.name, c.page, c.meta ->> 'heading' as heading,
         1 - (c.embedding <=> $2::vector) as rank,
         left(c.content, 500) as snippet
  from "DocChunk" c
  join "Source" s on s.id = c."sourceId"
  where c."orgId" = $1 and c.embedding is not null
    and ${LIVE}
  order by c.embedding <=> $2::vector
  limit $3`;

/**
 * Hybrid search: keyword ranking always; vector similarity too when an
 * embeddings key is set. Results are merged by reciprocal rank.
 */
export const searchDocuments = async (
  orgId: string,
  query: string,
  limit = 6
): Promise<DocHit[]> => {
  const terms = searchTerms(query);
  const keyword = terms.length
    ? await database.$queryRawUnsafe<Row[]>(
        KEYWORD_SQL,
        orgId,
        terms,
        limit * 2
      )
    : [];

  let vector: Row[] = [];
  if (canEmbed) {
    try {
      const { embedding } = await embed({
        model: models.embeddings,
        value: query,
        ...embeddingOptions("query"),
      });
      vector = await database.$queryRawUnsafe<Row[]>(
        VECTOR_SQL,
        orgId,
        vectorLiteral(embedding),
        limit * 2
      );
    } catch (error) {
      log.warn("Vector search failed; using keywords only", {
        error: String(error),
      });
    }
  }

  const scores = new Map<string, { row: Row; score: number }>();
  for (const list of [keyword, vector]) {
    list.forEach((row, index) => {
      const entry = scores.get(row.id) ?? { row, score: 0 };
      entry.score += 1 / (60 + index);
      // Prefer the keyword snippet (it highlights the matched words).
      if (list === keyword) {
        entry.row = row;
      }
      scores.set(row.id, entry);
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row, score }) => ({
      chunkId: row.id,
      sourceId: row.sourceId,
      sourceName: row.name,
      page: row.page,
      heading: row.heading,
      snippet: cleanSnippet(row.snippet),
      score: Number(score.toFixed(4)),
    }));
};
