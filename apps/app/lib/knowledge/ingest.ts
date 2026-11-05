import "server-only";

import { database, forOrg } from "@repo/database";
import { log } from "@repo/observability/log";
import { changesModel } from "../facts/attributes";
import { findSubject, proposeFact } from "../facts/facts";
import { extractFacts, shopContext } from "../facts/notes";
import { chunkPages, type PageText } from "./chunk";
import { cleanName, storeDocument } from "./documents";
import { readDocument } from "./read";
import { normalize } from "./resolve";
import {
  contextualize,
  DOC_TYPE_LABEL,
  loadCatalog,
  type Mention,
  type Understanding,
  understandDocument,
} from "./understand";

/** Facts are read in windows this long, up to a limit per document. */
const FACT_WINDOW = 8000;
const MAX_FACT_WINDOWS = 6;

export type IngestEvent =
  | { type: "step"; text: string }
  | {
      type: "done";
      facts: string[];
      linked: number;
      name: string;
      passages: number;
    }
  | { type: "error"; error: string };

const plural = (n: number, word: string, many = `${word}s`) =>
  `${n} ${n === 1 ? word : many}`;

const KIND_WORDS: Record<string, [string, string]> = {
  part: ["part", "parts"],
  machine: ["machine", "machines"],
  customer: ["customer", "customers"],
  material: ["material", "materials"],
};

const countByType = (mentions: { type: string }[]) =>
  Object.entries(KIND_WORDS)
    .map(([type, [one, many]]) => {
      const n = mentions.filter((m) => m.type === type).length;
      return n ? plural(n, one, many) : "";
    })
    .filter(Boolean)
    .join(", ");

const list = (items: string[], max = 6) =>
  items.length > max
    ? `${items.slice(0, max).join(", ")} and ${items.length - max} more`
    : items.join(", ");

const extractedLine = (pages: number, recognized: number) => {
  const images = recognized === 1 ? "an image" : "images";
  return `Extracted text from ${plural(pages, "page")}${
    recognized ? ` (${recognized} read from ${images})` : ""
  }`;
};

/** The records a passage names: by their name, or by the quote that named them. */
const mentionsIn = (content: string, linked: Mention[]) => {
  const text = normalize(content);
  return linked
    .filter((m) => {
      const name = normalize(m.label.split(" rev ")[0]);
      return (
        (name.length >= 3 && text.includes(name)) ||
        (m.quote.length > 12 && content.includes(m.quote.slice(0, 60)))
      );
    })
    .map((m) => `${m.type}:${m.id}`);
};

const windows = (text: string) =>
  Array.from(
    {
      length: Math.min(MAX_FACT_WINDOWS, Math.ceil(text.length / FACT_WINDOW)),
    },
    (_, i) => text.slice(i * FACT_WINDOW, (i + 1) * FACT_WINDOW)
  );

interface FactTally {
  confirmed: number;
  conflicts: number;
  proposed: string[];
  skipped: number;
}

type DocumentFact = Awaited<ReturnType<typeof extractFacts>>[number];

/** Propose one fact the document states, and count how it went. */
const proposeOne = async (
  orgId: string,
  userId: string | null,
  name: string,
  fact: DocumentFact,
  tally: FactTally
) => {
  const found = await findSubject(orgId, fact.subjectType, {
    partNo: fact.partNo,
    rev: fact.rev,
    seq: fact.seq,
    name: fact.name,
  });
  if (!found.ok) {
    tally.skipped += 1;
    return;
  }
  const made = await proposeFact(orgId, {
    subject: found.subject,
    attribute: fact.attribute,
    value: fact.value,
    evidence: `"${fact.quote}" (${name})`,
    source: "document",
    statedBy: userId,
  });
  if (!made.ok) {
    // "already has": the document agrees with what the shop has.
    if (made.error.includes(" already has ")) {
      tally.confirmed += 1;
    } else {
      tally.skipped += 1;
    }
    return;
  }
  if (made.existing || tally.proposed.includes(made.fact.label)) {
    return;
  }
  tally.proposed.push(made.fact.label);
  // A number that differs from the shop's current one.
  if (changesModel(fact.attribute)) {
    tally.conflicts += 1;
  }
};

/** Read the facts a document states (the slow, AI part). */
const readDocumentFacts = async (orgId: string, text: string) => {
  const context = await shopContext(orgId);
  const facts: DocumentFact[] = [];
  for (const window of windows(text)) {
    facts.push(
      ...(await extractFacts(orgId, window, { kind: "document", context }))
    );
  }
  return facts;
};

/** Propose what the document says as facts; count what it confirms. */
const proposeDocumentFacts = async (
  orgId: string,
  userId: string | null,
  name: string,
  facts: DocumentFact[]
) => {
  const tally: FactTally = {
    proposed: [],
    conflicts: 0,
    confirmed: 0,
    skipped: 0,
  };
  for (const fact of facts) {
    await proposeOne(orgId, userId, name, fact, tally);
  }
  return tally;
};

/** Say what the document is and which records it was linked to. */
const reportUnderstanding = (
  emit: (event: IngestEvent) => void,
  { card, linked, unmatched }: Understanding
) => {
  emit({
    type: "step",
    text: `Identified a ${DOC_TYPE_LABEL[card.docType]}: ${card.title}${
      card.revision ? `, rev ${card.revision}` : ""
    }`,
  });
  if (linked.length || unmatched.length) {
    emit({
      type: "step",
      text: `Found ${countByType([...linked, ...unmatched])}`,
    });
  }
  if (linked.length) {
    emit({
      type: "step",
      text: `Linked to your records: ${list(linked.map((m) => m.label))}`,
    });
  }
  if (unmatched.length) {
    emit({
      type: "step",
      text: `Not in your records: ${list(unmatched.map((m) => m.name))}`,
    });
  }
};

/** What the facts step found, as one or two lines. */
const reportFacts = (emit: (event: IngestEvent) => void, facts: FactTally) => {
  if (facts.confirmed) {
    emit({
      type: "step",
      text: `Confirmed ${plural(facts.confirmed, "value")} already in your records`,
    });
  }
  const differ = facts.conflicts
    ? ` (${plural(facts.conflicts, "differs", "differ")} from your records)`
    : "";
  emit({
    type: "step",
    text: facts.proposed.length
      ? `Proposed ${plural(facts.proposed.length, "fact")} for review${differ}: ${list(facts.proposed)}`
      : "No new facts to review",
  });
};

/**
 * Read a document, understand it, link it to the shop's records, index it for
 * search and propose its facts for review, reporting each step as it goes.
 * Without `mayReplace`, a document with the same name is never replaced:
 * storing throws DocumentExistsError and no facts are proposed.
 */
export const ingestDocument = async (
  orgId: string,
  userId: string | null,
  file: { name: string; bytes: Uint8Array },
  emit: (event: IngestEvent) => void,
  { mayReplace }: { mayReplace: boolean }
) => {
  emit({ type: "step", text: `Reading ${file.name}` });
  const read = await readDocument(orgId, file.name, file.bytes, (done, total) =>
    emit({ type: "step", text: `Recognising text: page ${done} of ${total}` })
  );
  return understandAndStore(
    orgId,
    userId,
    { name: cleanName(file.name), mayReplace },
    read.pages,
    read.recognized,
    emit
  );
};

/**
 * Read again a document that's already stored (from its saved text): for
 * documents indexed before Takumo understood them.
 */
export const rereadDocument = async (
  orgId: string,
  userId: string | null,
  sourceId: string,
  emit: (event: IngestEvent) => void
) => {
  const db = forOrg(database, orgId);
  const source = await db.source.findFirst({
    where: { id: sourceId },
    select: { name: true },
  });
  if (!source) {
    throw new Error("No text found: that document isn't stored any more.");
  }
  const chunks = await db.docChunk.findMany({
    where: { sourceId, NOT: { meta: { path: ["kind"], equals: "card" } } },
    orderBy: { id: "asc" },
    select: { content: true, page: true },
  });
  // Passages overlap a little; that's harmless for reading them again.
  const byPage = new Map<number | null, string[]>();
  for (const c of chunks) {
    byPage.set(c.page, [...(byPage.get(c.page) ?? []), c.content]);
  }
  const pages = [...byPage.entries()]
    .sort(([a], [b]) => (a ?? 0) - (b ?? 0))
    .map(([page, texts]) => ({ page, text: texts.join("\n\n") }));
  emit({ type: "step", text: `Reading ${source.name} again` });
  // Reading again rewrites this same document; the route allows it only for
  // people who may replace documents.
  return understandAndStore(
    orgId,
    userId,
    { name: source.name, mayReplace: true },
    pages,
    0,
    emit
  );
};

const understandAndStore = async (
  orgId: string,
  userId: string | null,
  { name, mayReplace }: { name: string; mayReplace: boolean },
  pages: PageText[],
  recognized: number,
  emit: (event: IngestEvent) => void
) => {
  const text = pages
    .map((p) => p.text)
    .join("\n\n")
    .trim();
  if (!text) {
    throw new Error("No text found in that file.");
  }
  emit({ type: "step", text: extractedLine(pages.length, recognized) });

  // Reading facts is the slowest step: start it now, alongside the rest.
  const factsRead = readDocumentFacts(orgId, text).then(
    (facts) => ({ ok: true as const, facts }),
    (error: unknown) => ({ ok: false as const, error })
  );
  const shop = await loadCatalog(orgId);
  const understood = await understandDocument(orgId, name, text, shop);
  const { card, linked, unmatched } = understood;
  reportUnderstanding(emit, understood);

  const chunks = chunkPages(pages);
  const tables = chunks.filter((c) => c.content.includes("| --- |")).length;
  emit({
    type: "step",
    text: `Split into ${plural(chunks.length, "passage")}${
      tables ? ` (${plural(tables, "table")} kept whole)` : ""
    }`,
  });
  const contexts = await contextualize(
    orgId,
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
  const stored = await storeDocument(
    orgId,
    name,
    card.summary,
    [
      {
        content: cardText,
        heading: null,
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
        ...c,
        context: contexts[i] || undefined,
        meta: { mentions: mentionsIn(c.content, linked) },
      })),
    ],
    { mayReplace }
  );
  emit({
    type: "step",
    text: `Indexed ${plural(chunks.length, "passage")} for search${
      stored.embedded ? " by meaning and keywords" : " by keywords"
    }`,
  });

  let facts: FactTally = {
    proposed: [],
    conflicts: 0,
    confirmed: 0,
    skipped: 0,
  };
  const factsResult = await factsRead;
  if (factsResult.ok) {
    facts = await proposeDocumentFacts(orgId, userId, name, factsResult.facts);
  } else {
    // The document is saved and searchable; facts can be read again later.
    log.warn("Reading facts from a document failed", {
      error: String(factsResult.error),
    });
    emit({ type: "step", text: "Couldn't read facts from it this time" });
  }
  reportFacts(emit, facts);
  emit({
    type: "step",
    text: linked.length
      ? `Updated Brain: ${name} → ${plural(linked.length, "record")}`
      : "Updated Brain",
  });
  emit({
    type: "done",
    name,
    passages: chunks.length,
    linked: linked.length,
    facts: facts.proposed,
  });
  return { sourceId: stored.sourceId, name, facts: facts.proposed };
};
