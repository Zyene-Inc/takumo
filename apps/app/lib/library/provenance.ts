import "server-only";

import { database, Prisma } from "@repo/database";
import {
  citedDocumentId,
  collectSources,
  type Source,
} from "../agent/citations";
import { parseFactLabel } from "../facts/attributes";

// Which documents fed each saved answer (MessageSource), so an answer is
// hidden from someone who can't use one of them any more
// (lib/agent/redact.ts), and so a permanent delete finds every answer to
// rewrite.
//
// An answer's documents are the ones its tools returned (search results),
// the documents behind facts it read, and every document behind earlier
// answers in the same conversation, since a later answer can repeat what an
// earlier one said. A query over the facts view reads facts in bulk: every
// document behind a fact that view can show counts. Anything that can't be
// attributed (an answer saved before this was recorded, a fact of unknown
// origin) marks the answer "partial": never assumed safe.

export interface ToolUse {
  input: unknown;
  output: unknown;
  tool: string;
}

interface SourceRow {
  direct: boolean;
  sourceId: string;
  versionId: string | null;
  via: "document" | "fact" | "inherited";
}

export interface AnswerProvenance {
  /** Every document the answer drew on, directly or through earlier answers. */
  documentIds: string[];
  /**
   * A document the answer's tools returned no longer exists in this shop:
   * permanently deleted while the answer was being written.
   */
  gone: boolean;
  provenance: "recorded" | "partial";
  rows: SourceRow[];
}

/** What a saved answer becomes when a document it used is permanently deleted. */
export const REMOVED_ANSWER =
  "Removed: this answer used a document that was permanently deleted.";

/** The fields to save instead of an answer that used a deleted document. */
export const removedAnswer = () => ({
  content: REMOVED_ANSWER,
  parts: [{ type: "text", text: REMOVED_ANSWER }],
  citations: Prisma.DbNull,
  toolCalls: Prisma.DbNull,
  provenance: "removed",
});

const FACTS_VIEW = /\bfacts\b/i;
// U&"…" spells an identifier with Unicode escapes, so it can name the facts
// view without the word appearing (security audit L8): treated as reading it.
const UNICODE_IDENTIFIER = /u&\s*["']/i;

/** A query over the facts view reads facts in bulk: their documents can't all be known. */
const readsFactsInBulk = (tools: ToolUse[]) =>
  tools.some(
    (t) =>
      t.tool === "query_data" &&
      [FACTS_VIEW, UNICODE_IDENTIFIER].some((pattern) =>
        pattern.test(String((t.input as { sql?: unknown })?.sql ?? ""))
      )
  );

// The documents behind every fact the SQL reader's facts view can show
// (library.fact_access for the whole shop): published facts are company
// knowledge on purpose, so only unpublished facts read from documents
// count. Facts of unknown origin it can show make the answer partial.
const BULK_FACT_SOURCES_SQL = `
  select distinct fs."sourceId", fs."versionId"
  from library.fact_access($1, null, null) a
  join "Fact" f on f.id = a.fact_id
  join "FactSource" fs on fs."factId" = f.id and fs."orgId" = $1
  where f."publishedAt" is null and f.provenance = 'documents'`;

const BULK_UNTRACED_SQL = `
  select exists (
    select 1 from library.fact_access($1, null, null) a
    join "Fact" f on f.id = a.fact_id
    where f."publishedAt" is null and f.provenance <> 'documents' and f.provenance <> 'none'
  ) as untraced`;

const bulkFactSources = async (orgId: string, tools: ToolUse[]) => {
  if (!readsFactsInBulk(tools)) {
    return { rows: [], untraced: false };
  }
  const [rows, [flag]] = await Promise.all([
    database.$queryRawUnsafe<{ sourceId: string; versionId: string | null }[]>(
      BULK_FACT_SOURCES_SQL,
      orgId
    ),
    database.$queryRawUnsafe<{ untraced: boolean }[]>(BULK_UNTRACED_SQL, orgId),
  ]);
  return { rows, untraced: Boolean(flag?.untraced) };
};

export const answerProvenance = async (
  orgId: string,
  conversationId: string,
  tools: ToolUse[]
): Promise<AnswerProvenance> => {
  const cited = [...collectSources(tools.map((t) => t.output)).values()];
  // Every document any tool returned, read from each result rather than from
  // the citation registry: that keeps one source per citation id, and two
  // documents with the same name (and page) share an id, so one of them was
  // lost and its answer escaped redaction (security audit M1).
  const documentIds = new Set(
    tools
      .flatMap((t) => {
        const sources = (t.output as { sources?: unknown })?.sources;
        return Array.isArray(sources) ? (sources as Source[]) : [];
      })
      .map((s) => (s && typeof s === "object" ? citedDocumentId(s) : null))
      .filter((id): id is string => Boolean(id))
  );
  const factNumbers = cited
    .filter((s) => s.kind === "fact")
    .map((s) => parseFactLabel(s.label))
    .filter((n): n is number => n !== null);

  const [documents, facts, earlier, unattributed, bulk] = await Promise.all([
    database.source.findMany({
      where: { orgId, id: { in: [...documentIds] } },
      select: { id: true, currentVersionId: true },
    }),
    database.fact.findMany({
      where: { orgId, number: { in: factNumbers } },
      select: {
        provenance: true,
        publishedAt: true,
        sources: { select: { sourceId: true, versionId: true } },
      },
    }),
    database.messageSource.findMany({
      where: { orgId, conversationId },
      distinct: ["sourceId"],
      select: { sourceId: true, versionId: true },
    }),
    database.message.count({
      where: {
        conversationId,
        role: "assistant",
        provenance: { in: ["legacy", "partial"] },
      },
    }),
    bulkFactSources(orgId, tools),
  ]);

  const rows = new Map<string, SourceRow>();
  for (const d of documents) {
    rows.set(d.id, {
      sourceId: d.id,
      versionId: d.currentVersionId,
      direct: true,
      via: "document",
    });
  }
  // A published fact is company knowledge on purpose: its documents don't
  // restrict the answer (their quotes aren't shown to those who can't open
  // them).
  const factSources = [
    ...facts.filter((f) => !f.publishedAt).flatMap((f) => f.sources),
    ...bulk.rows,
  ];
  for (const s of factSources) {
    if (!rows.has(s.sourceId)) {
      rows.set(s.sourceId, { ...s, direct: true, via: "fact" });
    }
  }
  for (const s of earlier) {
    if (!rows.has(s.sourceId)) {
      rows.set(s.sourceId, { ...s, direct: false, via: "inherited" });
    }
  }
  const partial =
    unattributed > 0 ||
    bulk.untraced ||
    facts.some(
      (f) =>
        !f.publishedAt &&
        (f.provenance === "unknown" || f.provenance === "source_deleted")
    ) ||
    // A fact cited by number that isn't in this shop: can't be attributed.
    facts.length < new Set(factNumbers).size;
  const gone = documents.length < documentIds.size;
  return {
    provenance: partial || gone ? "partial" : "recorded",
    rows: [...rows.values()],
    documentIds: [...rows.keys()],
    gone,
  };
};

// Locks the answer's documents until it is saved, so a permanent delete
// either finishes first (and the document is missing here) or waits and
// then finds this answer to rewrite.
const LIVE_SOURCES_SQL = `
  select id from "Source" where "orgId" = $1 and id = any($2::text[])
  for key share`;

/**
 * Inside the transaction saving an answer: its documents as they are now.
 * Any that were permanently deleted since the answer was worked out are
 * dropped and `gone` is set: the caller saves the answer as removed
 * (removedAnswer), as the delete would have done.
 */
export const settleSources = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  found: AnswerProvenance
): Promise<AnswerProvenance> => {
  if (found.rows.length === 0) {
    return found;
  }
  const live = new Set(
    (
      await tx.$queryRawUnsafe<{ id: string }[]>(
        LIVE_SOURCES_SQL,
        orgId,
        found.rows.map((r) => r.sourceId)
      )
    ).map((r) => r.id)
  );
  const rows = found.rows.filter((r) => live.has(r.sourceId));
  const gone = found.gone || rows.length < found.rows.length;
  return {
    rows,
    documentIds: rows.map((r) => r.sourceId),
    gone,
    // What came from a deleted document can't be attributed any more.
    provenance: gone ? "partial" : found.provenance,
  };
};

/** Save the answer's documents with it (inside the transaction saving the answer). */
export const recordAnswerSources = (
  tx: Prisma.TransactionClient,
  orgId: string,
  conversationId: string,
  messageId: string,
  found: AnswerProvenance
) =>
  tx.messageSource.createMany({
    data: found.rows.map((r) => ({
      orgId,
      conversationId,
      messageId,
      sourceId: r.sourceId,
      versionId: r.versionId,
      direct: r.direct,
      via: r.via,
    })),
    skipDuplicates: true,
  });

/**
 * Facts proposed in this answer came from the conversation: every document
 * it drew on becomes one of their sources. Their provenance is settled only
 * when everything was attributable; otherwise it stays "unknown".
 */
export const linkProposedFacts = async (
  tx: Prisma.TransactionClient,
  orgId: string,
  tools: ToolUse[],
  found: AnswerProvenance
) => {
  const numbers = tools
    .filter((t) => t.tool === "propose_fact")
    .map((t) => (t.output as { fact?: unknown })?.fact)
    .map((label) => (typeof label === "string" ? parseFactLabel(label) : null))
    .filter((n): n is number => n !== null);
  if (numbers.length === 0) {
    return;
  }
  const facts = await tx.fact.findMany({
    where: { orgId, number: { in: numbers } },
    select: { id: true, provenance: true, source: true },
  });
  for (const fact of facts) {
    if (found.documentIds.length > 0) {
      await tx.factSource.createMany({
        data: found.rows.map((r) => ({
          orgId,
          factId: fact.id,
          sourceId: r.sourceId,
          versionId: r.versionId,
        })),
        skipDuplicates: true,
      });
    }
    if (fact.source === "chat" && fact.provenance === "unknown") {
      const settled = found.documentIds.length > 0 ? "documents" : "none";
      await tx.fact.update({
        where: { id: fact.id },
        data: {
          provenance: found.provenance === "partial" ? "unknown" : settled,
        },
      });
    }
  }
};
