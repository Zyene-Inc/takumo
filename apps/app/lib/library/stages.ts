import "server-only";

import { embedMany } from "@repo/ai";
import { canEmbed, embeddingOptions, models } from "@repo/ai/lib/models";
import { database } from "@repo/database";
import { log } from "@repo/observability/log";
import { chunkPages, plainSummary } from "../knowledge/chunk";
import { readDocument } from "../knowledge/read";
import {
  extractedLine,
  type FactTally,
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
  documentAiMode,
  dropIfLowered,
  localPassages,
  localUnderstanding,
  NO_TEXT_AI_OFF,
  writeIfFull,
} from "./ai-mode";
import {
  finishVersion,
  type Lease,
  LeaseLost,
  renewLease,
  saveProgress,
} from "./lease";
import { DocumentProblem } from "./problems";
import {
  type Checkpoint,
  checkpointOf,
  HandOff,
  loadPages,
  mayUseAi,
  type Run,
  savePages,
  sourceName,
  textOf,
} from "./stage-run";
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
//
// The folder's AI setting (ai-mode.ts) is read before every stage that
// would send the text to an outside AI service, and what comes back is only
// written while it is still "full" (writeIfFull). With "off" or "search" the
// document is read, split and indexed locally: no recognising of scans, no
// understanding, context sentences, vectors or facts.

export { NO_TEXT_AI_OFF } from "./ai-mode";
export { HandOff, type Run, type RunOptions } from "./stage-run";

const EMBED_BATCH = 64;
const NO_ORIGINAL =
  "The original file wasn't kept, so it can't be read again. Upload it again.";

const vectorLiteral = (values: number[]) => `[${values.join(",")}]`;

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
  const mayRecognize = await mayUseAi(lease);
  const result = await readDocument(version.orgId, version.name, bytes, {
    known,
    recognize: mayRecognize,
    onProgress: (done, total) =>
      emit({
        type: "step",
        text: `Recognising text: page ${done} of ${total}`,
      }),
    onRecognized: async (pages) => {
      // AI turned off meanwhile: keep nothing it read, and start again
      // without it.
      if (!(await mayUseAi(lease))) {
        throw new HandOff();
      }
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
    checkpoint: { recognized: result.recognized, unread: result.unread ?? 0 },
  });
  if (result.unread) {
    emit({
      type: "step",
      text: `Left ${plural(result.unread, "scanned page")} unread: AI processing is off for this folder`,
    });
  }
};

/** Stage "understand": what the document is and which records it's about. */
export const understand = async ({ lease, emit }: Run) => {
  const pages = await loadPages(lease);
  const text = textOf(pages);
  if (!text) {
    throw new DocumentProblem(
      checkpointOf(lease).unread
        ? NO_TEXT_AI_OFF
        : "No text found in that file.",
      { permanent: true }
    );
  }
  emit({
    type: "step",
    text: extractedLine(pages.length, checkpointOf(lease).recognized ?? 0),
  });
  const name = await sourceName(lease);
  let understanding: Understanding;
  if (await mayUseAi(lease)) {
    const shop = await loadCatalog(lease.version.orgId);
    understanding = await understandDocument(
      lease.version.orgId,
      name,
      text,
      shop
    );
    // Lowered while the AI service was answering: keep nothing it said
    // (security audit M2).
    if (!(await mayUseAi(lease))) {
      understanding = localUnderstanding(name, text);
    }
    reportUnderstanding(emit, understanding);
  } else {
    understanding = localUnderstanding(name, text);
    emit({
      type: "step",
      text: "AI processing is off for this folder: indexed for keyword search only",
    });
  }
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
  const name = await sourceName(lease);
  const full = await mayUseAi(lease);
  const understood = checkpointOf(lease).understanding;
  // What AI understood is only used while the setting still allows it, and
  // lowering it clears it from the checkpoint (ai-mode.ts).
  const understanding =
    full && understood ? understood : localUnderstanding(name, text);
  const { card, linked, unmatched } = understanding;
  const chunks = chunkPages(pages);
  const tables = chunks.filter((c) => c.content.includes("| --- |")).length;
  emit({
    type: "step",
    text: `Split into ${plural(chunks.length, "passage")}${
      tables ? ` (${plural(tables, "table")} kept whole)` : ""
    }`,
  });
  let contexts: string[] = full
    ? await contextualize(
        version.orgId,
        { name, summary: card.summary, text },
        chunks.map((c) => c.content),
        () => mayUseAi(lease)
      )
    : [];
  // Lowered meanwhile: no context sentence from the AI service is kept
  // (security audit M2).
  if (full && !(await mayUseAi(lease))) {
    contexts = [];
  }
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
  const data = (list: typeof rows) =>
    list.map((r, ordinal) => ({
      orgId: version.orgId,
      sourceId: version.sourceId,
      versionId: version.id,
      ordinal,
      content: r.content.replaceAll("\u0000", ""),
      page: r.page,
      meta: r.meta,
    }));
  const wroteAi =
    full &&
    (await writeIfFull(version.orgId, version.sourceId, (tx) =>
      tx.docChunk.createMany({ data: data(rows), skipDuplicates: true })
    ));
  if (!wroteAi) {
    // AI off (or turned off while it ran): a plain card and the passages.
    await database.docChunk.createMany({
      data: data(localPassages(name, chunks) as typeof rows),
      skipDuplicates: true,
    });
  }
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
  const { orgId, sourceId } = lease.version;
  if (canEmbed && (await mayUseAi(lease))) {
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
      // Checked before every batch: nothing more is sent once it's lowered.
      if (!(await mayUseAi(lease))) {
        break;
      }
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
      const wrote = await writeIfFull(orgId, sourceId, (tx) =>
        tx.$executeRawUnsafe(
          SET_EMBEDDINGS_SQL,
          batch.map((c) => c.id),
          embeddings.map(vectorLiteral),
          lease.version.id
        )
      );
      if (!wrote) {
        break;
      }
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
  const understood = checkpointOf(lease).understanding?.card.summary ?? null;
  const pageText = textOf(await loadPages(lease));
  const outcome = await database.$transaction(async (tx) => {
    const [source] = await tx.$queryRawUnsafe<
      { currentNumber: number | null; currentVersionId: string | null }[]
    >(LOCK_SOURCE_SQL, version.sourceId, version.orgId);
    if (!source) {
      throw new DocumentProblem("That document isn't stored any more.", {
        permanent: true,
      });
    }
    // The summary AI wrote only while the setting allows it (the row is
    // locked, so this is the setting in force).
    const full =
      (await documentAiMode(version.orgId, version.sourceId, tx)) === "full";
    const summary = full ? understood : plainSummary(pageText);
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
 * Read the facts the document states, once, into the checkpoint. Lowered
 * while reading (security audit M2): nothing read is kept. A failure is
 * recorded, not thrown; a hand-off (Trash) passes through.
 */
const readFactsOnce = async (
  lease: Lease,
  checkpoint: Checkpoint,
  emit: Run["emit"]
): Promise<Checkpoint> => {
  try {
    const text = textOf(await loadPages(lease));
    const read = await readDocumentFacts(lease.version.orgId, text, () =>
      mayUseAi(lease)
    );
    return read && (await mayUseAi(lease))
      ? { ...checkpoint, facts: read, factsDone: 0 }
      : { ...checkpoint, facts: [], factsDone: 0 };
  } catch (error) {
    if (error instanceof HandOff) {
      throw error;
    }
    log.warn("Reading facts from a document failed", {
      error: String(error),
    });
    emit({ type: "step", text: "Couldn't read facts from it this time" });
    return { ...checkpoint, factsError: true };
  }
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
  // Facts are read by an AI service: only while the setting allows it.
  const full = await mayUseAi(lease);
  // A newer version went live meanwhile: its own facts are what count.
  if (current && full && !checkpoint.facts && !checkpoint.factsError) {
    checkpoint = await readFactsOnce(lease, checkpoint, emit);
    await saveProgress(lease, { stage: "facts", checkpoint });
  }
  const found = current && full ? (checkpoint.facts ?? []) : [];
  for (let i = checkpoint.factsDone ?? 0; i < found.length; i += 1) {
    // A run that lost its lease proposes nothing more, nor one whose
    // folder's AI setting was lowered meanwhile (any fact that slips
    // through stays hidden: library.fact_access needs "full").
    await renewLease(lease);
    if (!(await mayUseAi(lease))) {
      break;
    }
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
    // Lowered while it was being proposed: lowering may have missed it, so
    // it's dropped here (security audit L1).
    if (await dropIfLowered(version.orgId, version.sourceId)) {
      break;
    }
    checkpoint = { ...checkpoint, factsDone: i + 1, tally };
    await saveProgress(lease, { stage: "facts", checkpoint });
    checkTime();
  }
  const linked = full ? (checkpoint.understanding?.linked ?? []) : [];
  const name = current?.name ?? version.name;
  if (full) {
    reportFacts(emit, tally);
    emit({
      type: "step",
      text: linked.length
        ? `Updated Brain: ${name} → ${plural(linked.length, "record")}`
        : "Updated Brain",
    });
  }
  await finishVersion(
    lease,
    "ready",
    checkpoint.factsError ? "Couldn't read facts from it this time." : null
  );
  return { tally, linked: linked.length, name };
};
