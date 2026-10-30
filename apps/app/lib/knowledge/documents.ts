import "server-only";

import { embed, embedMany } from "@repo/ai";
import { keys as aiKeys } from "@repo/ai/keys";
import { EMBEDDING_DIMENSIONS, models } from "@repo/ai/lib/models";
import { database, forOrg } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  type Chunk,
  chunkPages,
  cleanSnippet,
  type PageText,
  plainSummary,
  searchTerms,
} from "./chunk";

export { extractPages } from "./extract";

const FILE_EXTENSION = /\.(pdf|docx|txt|md|csv)$/i;
const BRACKETS = /[[\]]/g;
const SPACES = /\s+/g;

export { DOCUMENT_TYPES, MAX_DOCUMENT_BYTES } from "./types";

/** Display name: no file extension, no square brackets (they'd break [doc …] citations). */
export const cleanName = (fileName: string) =>
  fileName
    .replace(FILE_EXTENSION, "")
    .replace(BRACKETS, "")
    .replace(SPACES, " ")
    .trim()
    .slice(0, 160) || "Untitled";

const canEmbed = () => Boolean(aiKeys().OPENAI_API_KEY);

const vectorLiteral = (values: number[]) => `[${values.join(",")}]`;

const embeddingOptions = {
  providerOptions: { openai: { dimensions: EMBEDDING_DIMENSIONS } },
};

/** Store a document's chunks. Re-uploading a file with the same name replaces it. */
export const saveDocument = async (
  orgId: string,
  rawName: string,
  pages: PageText[]
) => {
  const name = cleanName(rawName);
  const chunks: Chunk[] = chunkPages(pages);
  if (chunks.length === 0) {
    throw new Error(
      "No text found. If it's a scanned PDF, it needs text recognition (OCR) first."
    );
  }
  const db = forOrg(database, orgId);
  await db.source.deleteMany({
    where: { name, type: "upload", profile: "document" },
  });
  const source = await db.source.create({
    data: {
      orgId,
      name,
      type: "upload",
      profile: "document",
      status: "ready",
      summary: plainSummary(chunks[0].content),
    },
  });
  const rows = chunks.map((c) => ({
    id: crypto.randomUUID(),
    orgId,
    sourceId: source.id,
    content: c.content,
    page: c.page,
    meta: c.heading ? { heading: c.heading } : {},
  }));
  await db.docChunk.createMany({ data: rows });

  if (canEmbed()) {
    try {
      const { embeddings } = await embedMany({
        model: models.embeddings,
        values: rows.map((r) => r.content),
        ...embeddingOptions,
      });
      await database.$transaction(
        rows.map((row, i) =>
          database.$executeRawUnsafe(
            `update "DocChunk" set embedding = $1::vector where id = $2 and "orgId" = $3`,
            vectorLiteral(embeddings[i]),
            row.id,
            orgId
          )
        )
      );
    } catch (error) {
      // Keyword search still works without vectors.
      log.warn("Embedding failed; document is keyword-searchable only", {
        error: String(error),
      });
    }
  }
  return { sourceId: source.id, name, chunks: rows.length };
};

export interface DocHit {
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

const KEYWORD_SQL = `
  with q as (
    select string_agg(t.q::text, ' | ')::tsquery as query
    from (select plainto_tsquery('english', w) as q from unnest($2::text[]) w) t
    where t.q::text <> ''
  )
  select c.id, c."sourceId", s.name, c.page, c.meta ->> 'heading' as heading,
         ts_rank_cd(to_tsvector('english', c.content), q.query) as rank,
         ts_headline('english', c.content, q.query,
           'StartSel=«, StopSel=», MaxWords=70, MinWords=30, MaxFragments=2, FragmentDelimiter=" … "') as snippet
  from "DocChunk" c
  join "Source" s on s.id = c."sourceId"
  cross join q
  where c."orgId" = $1 and q.query is not null
    and to_tsvector('english', c.content) @@ q.query
  order by rank desc
  limit $3`;

const VECTOR_SQL = `
  select c.id, c."sourceId", s.name, c.page, c.meta ->> 'heading' as heading,
         1 - (c.embedding <=> $2::vector) as rank,
         left(c.content, 500) as snippet
  from "DocChunk" c
  join "Source" s on s.id = c."sourceId"
  where c."orgId" = $1 and c.embedding is not null
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
  if (canEmbed()) {
    try {
      const { embedding } = await embed({
        model: models.embeddings,
        value: query,
        ...embeddingOptions,
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
