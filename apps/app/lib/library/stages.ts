import "server-only";

import { embedMany } from "@repo/ai";
import { canEmbed, embeddingOptions, models } from "@repo/ai/lib/models";
import { database } from "@repo/database";
import { log } from "@repo/observability/log";
import { chunkPages } from "../knowledge/chunk";
import { readDocument } from "../knowledge/read";
import {
  type DocumentFact,
  extractedLine,
  type FactTally,
  type IngestEvent,
  mentionsIn,
  plural,
  proposeOne,
  readDocumentFacts,
  reportFacts,
  reportUnderstanding,
} from "../knowledge/steps";
import {
  contextualize,
  DOC_TYPE_LABEL,
  loadCatalog,
  type Understanding,
  understandDocument,
} from "../knowledge/understand";
import {
  finishVersion,
  type Lease,
  LeaseLost,
  renewLease,
  saveProgress,
} from "./lease";
import { DocumentProblem } from "./problems";
import { objectStore } from "./storage";

// The stages of processing one document version (run by process.ts), each
// saving its result:
//
//   read → understand → chunk → embed → activate → facts → done
//
// A run holds the version's lease (lease.ts). If it stops at any point, the
// next run starts at the saved stage: pages already read aren't read again,
// passages already written aren't written twice (versionId, ordinal), and
// facts already proposed aren't proposed again. The version becomes the
// document's current one at "activate", in one transaction, and only if no
// newer version is current; until then searches keep using the previous
// version, so a failed new version never hides a working one. Facts are
// proposed after activation, so nothing from a version that never went live
// reaches review.

/** Out of time in this run: save and let another run continue. */
export class HandOff extends Error {}

interface Checkpoint {
  facts?: DocumentFact[];
  factsDone?: number;
  factsError?: boolean;
  recognized?: number;
  tally?: FactTally;
  understanding?: Understanding;
}

export interface RunOptions {
  /** The file, when the run starts right after the upload (saves a download). */
  bytes?: Uint8Array;
  /** Stop and hand off at this time (ms since epoch). */
  deadline?: number;
  emit?: (event: IngestEvent) => void;
}

const EMBED_BATCH = 64;
const NO_ORIGINAL =
  "The original file wasn't kept, so it can't be read again. Upload it again.";

const vectorLiteral = (values: number[]) => `[${values.join(",")}]`;

export interface Run {
  checkTime: () => void;
  emit: (event: IngestEvent) => void;
  lease: Lease;
  options: RunOptions;
}

const checkpointOf = (lease: Lease) =>
  (lease.version.checkpoint ?? {}) as Checkpoint;

const sourceName = async (lease: Lease) =>
  (
    await database.source.findUniqueOrThrow({
      where: { id: lease.version.sourceId },
      select: { name: true },
    })
  ).name;

// Pages are saved as they're read; reading again overwrites them.
const SAVE_PAGES_SQL = `
  insert into "DocumentPage" ("orgId", "versionId", position, page, text, recognized)
  select $1, $2, p.position, p.page, p.text, p.recognized
  from unnest($3::int[], $4::int[], $5::text[], $6::boolean[])
    as p(position, page, text, recognized)
  on conflict ("versionId", position) do update
    set page = excluded.page, text = excluded.text, recognized = excluded.recognized`;

const savePages = async (
  lease: Lease,
  pages: { page: number | null; position: number; text: string }[],
  scanned: Set<number>
) => {
  await renewLease(lease);
  await database.$executeRawUnsafe(
    SAVE_PAGES_SQL,
    lease.version.orgId,
    lease.version.id,
    pages.map((p) => p.position),
    pages.map((p) => p.page),
    // Postgres can't store NUL characters in text.
    pages.map((p) => p.text.replaceAll("\u0000", "")),
    pages.map((p) => p.page !== null && scanned.has(p.page))
  );
};

const loadPages = (lease: Lease) =>
  database.documentPage.findMany({
    where: { versionId: lease.version.id, orgId: lease.version.orgId },
    orderBy: { position: "asc" },
    select: { page: true, text: true, recognized: true },
  });

/** Stage "read": the file's text, page by page, saved as it's read. */
export const read = async ({ lease, emit, options, checkTime }: Run) => {
  const { version } = lease;
  let bytes = options.bytes ?? null;
  if (!bytes) {
    const store = objectStore();
    if (!(store && version.storageKey)) {
      throw new DocumentProblem(NO_ORIGINAL, { permanent: true });
    }
    bytes = await store.get(version.storageKey);
  }
  // Scanned pages an earlier run already read (by page number).
  const known = new Map<number, string>();
  for (const p of await loadPages(lease)) {
    if (p.recognized && p.page !== null) {
      known.set(p.page, p.text);
    }
  }
  const scanned = new Set(known.keys());
  const resumable = Boolean(version.storageKey && objectStore());
  emit({ type: "step", text: `Reading ${version.name}` });
  const result = await readDocument(version.orgId, version.name, bytes, {
    known,
    onProgress: (done, total) =>
      emit({
        type: "step",
        text: `Recognising text: page ${done} of ${total}`,
      }),
    onRecognized: async (pages) => {
      for (const p of pages) {
        scanned.add(p.page ?? 1);
      }
      await savePages(
        lease,
        pages.map((p) => ({ ...p, position: (p.page ?? 1) - 1 })),
        scanned
      );
      // Hand off mid-read only when the next run can fetch the file again.
      if (resumable) {
        checkTime();
      }
    },
  });
  await savePages(
    lease,
    result.pages.map((p, position) => ({ ...p, position })),
    scanned
  );
  await saveProgress(lease, {
    stage: "understand",
    pageCount: result.pages.length,
    checkpoint: { recognized: result.recognized },
  });
};

const textOf = (pages: { text: string }[]) =>
  pages
    .map((p) => p.text)
    .join("\n\n")
    .trim();

/** Stage "understand": what the document is and which records it's about. */
export const understand = async ({ lease, emit }: Run) => {
  const pages = await loadPages(lease);
  const text = textOf(pages);
  if (!text) {
    throw new DocumentProblem("No text found in that file.", {
      permanent: true,
    });
  }
  emit({
    type: "step",
    text: extractedLine(pages.length, checkpointOf(lease).recognized ?? 0),
  });
  const name = await sourceName(lease);
  const shop = await loadCatalog(lease.version.orgId);
  const understanding = await understandDocument(
    lease.version.orgId,
    name,
    text,
    shop
  );
  reportUnderstanding(emit, understanding);
  await saveProgress(lease, {
    stage: "chunk",
    checkpoint: { ...checkpointOf(lease), understanding },
  });
};

/** Stage "chunk": the card and the passages, written once each. */
export const chunk = async ({ lease, emit }: Run) => {
  const { version } = lease;
  const pages = await loadPages(lease);
  const text = textOf(pages);
  const understanding = checkpointOf(lease).understanding;
  if (!understanding) {
    throw new Error("Chunking before the document was understood");
  }
  const { card, linked, unmatched } = understanding;
  const name = await sourceName(lease);
  const chunks = chunkPages(pages);
  const tables = chunks.filter((c) => c.content.includes("| --- |")).length;
  emit({
    type: "step",
    text: `Split into ${plural(chunks.length, "passage")}${
      tables ? ` (${plural(tables, "table")} kept whole)` : ""
    }`,
  });
  const contexts = await contextualize(
    version.orgId,
    { name, summary: card.summary, text },
    chunks.map((c) => c.content)
  );
  const withContext = contexts.filter(Boolean).length;
  if (withContext) {
    emit({
      type: "step",
      text: `Added context to ${plural(withContext, "passage")}`,
    });
  }
  // A card for the whole document: found by questions about the document
  // itself, and the Brain's record of what it links to.
  const cardText = [
    `${name}: ${DOC_TYPE_LABEL[card.docType]}${card.revision ? `, rev ${card.revision}` : ""}.`,
    card.summary,
    linked.length ? `About: ${linked.map((m) => m.label).join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const rows = [
    {
      content: cardText,
      page: null,
      meta: {
        kind: "card",
        docType: card.docType,
        title: card.title,
        revision: card.revision,
        links: linked.map((m) => ({
          ref: `${m.type}:${m.id}`,
          label: m.label,
          quote: m.quote,
          how: m.how,
        })),
        unmatched,
      },
    },
    ...chunks.map((c, i) => ({
      content: c.content,
      page: c.page,
      meta: {
        ...(c.heading ? { heading: c.heading } : {}),
        ...(contexts[i] ? { context: contexts[i] } : {}),
        mentions: mentionsIn(c.content, linked),
      },
    })),
  ];
  await renewLease(lease);
  await database.docChunk.createMany({
    data: rows.map((r, ordinal) => ({
      orgId: version.orgId,
      sourceId: version.sourceId,
      versionId: version.id,
      ordinal,
      content: r.content.replaceAll("\u0000", ""),
      page: r.page,
      meta: r.meta,
    })),
    skipDuplicates: true,
  });
  await saveProgress(lease, { stage: "embed" });
};

const SET_EMBEDDINGS_SQL = `
  update "DocChunk" c set embedding = v.embedding::vector
  from unnest($1::text[], $2::text[]) as v(id, embedding)
  where c.id = v.id and c."versionId" = $3 and c.embedding is null`;

/**
 * Stage "embed": a vector for every passage still without one, in batches.
 * A failure fails the version (and it is retried), so a new version never
 * goes live searchable by keywords only while the old one had vectors.
 * Without an embedding model, keywords alone are used, as before.
 */
export const embed = async ({ lease, checkTime }: Run) => {
  if (canEmbed) {
    for (;;) {
      // Vectors are an Unsupported column in Prisma: find the passages
      // still without one in SQL.
      const missing = await database.$queryRawUnsafe<{ id: string }[]>(
        `select id from "DocChunk" where "versionId" = $1 and embedding is null
         order by ordinal limit $2`,
        lease.version.id,
        EMBED_BATCH
      );
      if (missing.length === 0) {
        break;
      }
      const batch = await database.docChunk.findMany({
        where: { id: { in: missing.map((m) => m.id) } },
        orderBy: { ordinal: "asc" },
        select: { id: true, content: true, meta: true },
      });
      const { embeddings } = await embedMany({
        model: models.embeddings,
        // The context sentence goes into the vector too.
        values: batch.map((c) => {
          const context = (c.meta as { context?: string } | null)?.context;
          return context ? `${context}\n\n${c.content}` : c.content;
        }),
        ...embeddingOptions("document"),
      });
      await renewLease(lease);
      await database.$executeRawUnsafe(
        SET_EMBEDDINGS_SQL,
        batch.map((c) => c.id),
        embeddings.map(vectorLiteral),
        lease.version.id
      );
      checkTime();
    }
  }
  await saveProgress(lease, { stage: "activate" });
};

// The version goes live only if no newer one already has. The document row
// is locked so two versions finishing at once take turns.
const LOCK_SOURCE_SQL = `
  select s."currentVersionId", cur.number as "currentNumber"
  from "Source" s
  left join "DocumentVersion" cur on cur.id = s."currentVersionId"
  where s.id = $1 and s."orgId" = $2
  for update of s`;

/** Stage "activate": make this version the document's current one, atomically. */
export const activate = async ({ lease, emit }: Run) => {
  const { version } = lease;
  const summary = checkpointOf(lease).understanding?.card.summary ?? null;
  const outcome = await database.$transaction(async (tx) => {
    const [source] = await tx.$queryRawUnsafe<
      { currentNumber: number | null; currentVersionId: string | null }[]
    >(LOCK_SOURCE_SQL, version.sourceId, version.orgId);
    if (!source) {
      throw new DocumentProblem("That document isn't stored any more.", {
        permanent: true,
      });
    }
    const held = await tx.documentVersion.updateMany({
      where: { id: version.id, leaseOwner: lease.token, status: "processing" },
      data: { activatedAt: new Date(), stage: "facts" },
    });
    if (held.count === 0) {
      throw new LeaseLost();
    }
    if (
      source.currentNumber !== null &&
      source.currentNumber > version.number
    ) {
      // A newer version went live first: this one stays as history,
      // finished here so a stop right after can't leave it half-done.
      await tx.documentVersion.update({
        where: { id: version.id },
        data: {
          activatedAt: null,
          stage: "done",
          status: "superseded",
          leaseOwner: null,
          leaseUntil: null,
          nextAttemptAt: null,
        },
      });
      await tx.docChunk.deleteMany({ where: { versionId: version.id } });
      return "superseded" as const;
    }
    await tx.source.update({
      where: { id: version.sourceId },
      data: { currentVersionId: version.id, status: "ready", summary },
    });
    // Other versions' passages are never searched again.
    await tx.docChunk.deleteMany({
      where: {
        sourceId: version.sourceId,
        orgId: version.orgId,
        OR: [{ versionId: null }, { NOT: { versionId: version.id } }],
      },
    });
    return "active" as const;
  });
  if (outcome === "superseded") {
    return outcome;
  }
  lease.version.stage = "facts";
  const passages = await database.docChunk.count({
    where: { versionId: version.id, NOT: { ordinal: 0 } },
  });
  emit({
    type: "step",
    text: `Indexed ${plural(passages, "passage")} for search${
      canEmbed ? " by meaning and keywords" : " by keywords"
    }`,
  });
  return outcome;
};

/**
 * Stage "facts": read the facts the document states and propose them for
 * review, saving after each so none is proposed twice. A failure here
 * doesn't undo the document, as before: it's live, and facts can be read
 * again later.
 */
export const facts = async ({ lease, emit, checkTime }: Run) => {
  const { version } = lease;
  // Only for the current version of a document that isn't in the Trash.
  const current = await database.source.findFirst({
    where: {
      id: version.sourceId,
      currentVersionId: version.id,
      deletedAt: null,
    },
    select: { name: true },
  });
  let checkpoint = checkpointOf(lease);
  const tally: FactTally = checkpoint.tally ?? {
    proposed: [],
    conflicts: 0,
    confirmed: 0,
    skipped: 0,
  };
  // A newer version went live meanwhile: its own facts are what count.
  if (current && !checkpoint.facts && !checkpoint.factsError) {
    try {
      const text = textOf(await loadPages(lease));
      checkpoint = {
        ...checkpoint,
        facts: await readDocumentFacts(version.orgId, text),
        factsDone: 0,
      };
    } catch (error) {
      log.warn("Reading facts from a document failed", {
        error: String(error),
      });
      emit({ type: "step", text: "Couldn't read facts from it this time" });
      checkpoint = { ...checkpoint, factsError: true };
    }
    await saveProgress(lease, { stage: "facts", checkpoint });
  }
  const found = current ? (checkpoint.facts ?? []) : [];
  for (let i = checkpoint.factsDone ?? 0; i < found.length; i += 1) {
    // A run that lost its lease proposes nothing more.
    await renewLease(lease);
    await proposeOne(
      version.orgId,
      version.uploadedBy,
      {
        name: current?.name ?? version.name,
        sourceId: version.sourceId,
        versionId: version.id,
      },
      found[i],
      tally
    );
    checkpoint = { ...checkpoint, factsDone: i + 1, tally };
    await saveProgress(lease, { stage: "facts", checkpoint });
    checkTime();
  }
  reportFacts(emit, tally);
  const linked = checkpoint.understanding?.linked ?? [];
  const name = current?.name ?? version.name;
  emit({
    type: "step",
    text: linked.length
      ? `Updated Brain: ${name} → ${plural(linked.length, "record")}`
      : "Updated Brain",
  });
  await finishVersion(
    lease,
    "ready",
    checkpoint.factsError ? "Couldn't read facts from it this time." : null
  );
  return { tally, linked: linked.length, name };
};
