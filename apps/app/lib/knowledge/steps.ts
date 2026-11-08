import "server-only";

import { changesModel } from "../facts/attributes";
import { findSubject, proposeFact } from "../facts/facts";
import { extractFacts, shopContext } from "../facts/notes";
import { normalize } from "./resolve";
import { DOC_TYPE_LABEL, type Mention, type Understanding } from "./understand";

// The steps of reading a document that people see as it happens, and the
// facts it states. Used by the library's processing (lib/library/process.ts).

export type IngestEvent =
  | { type: "step"; text: string }
  | {
      type: "done";
      facts: string[];
      linked: number;
      name: string;
      passages: number;
      /** Still being read in the background; it appears when it's ready. */
      background?: boolean;
    }
  | { type: "error"; error: string };

/** Facts are read in windows this long, up to a limit per document. */
const FACT_WINDOW = 8000;
const MAX_FACT_WINDOWS = 6;

export const plural = (n: number, word: string, many = `${word}s`) =>
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

export const extractedLine = (pages: number, recognized: number) => {
  const images = recognized === 1 ? "an image" : "images";
  return `Extracted text from ${plural(pages, "page")}${
    recognized ? ` (${recognized} read from ${images})` : ""
  }`;
};

/** The records a passage names: by their name, or by the quote that named them. */
export const mentionsIn = (content: string, linked: Mention[]) => {
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

export interface FactTally {
  confirmed: number;
  conflicts: number;
  proposed: string[];
  skipped: number;
}

export type DocumentFact = Awaited<ReturnType<typeof extractFacts>>[number];

/** Propose one fact the document states, and count how it went. */
export const proposeOne = async (
  orgId: string,
  userId: string | null,
  document: { name: string; sourceId: string; versionId: string },
  fact: DocumentFact,
  tally: FactTally
) => {
  const { name } = document;
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
    // Where it was read: kept with the fact (FactSource), and added to a
    // pending fact that another document already stated.
    documents: [
      {
        sourceId: document.sourceId,
        versionId: document.versionId,
        quote: fact.quote,
      },
    ],
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

/**
 * Read the facts a document states (the slow, AI part). `allowed` is asked
 * before every window: once it says no (the AI setting was lowered), nothing
 * more is sent and the result is null (security audit M2).
 */
export const readDocumentFacts = async (
  orgId: string,
  text: string,
  allowed: () => Promise<boolean> = async () => true
): Promise<DocumentFact[] | null> => {
  const context = await shopContext(orgId);
  const facts: DocumentFact[] = [];
  for (const window of windows(text)) {
    if (!(await allowed())) {
      return null;
    }
    facts.push(
      ...(await extractFacts(orgId, window, { kind: "document", context }))
    );
  }
  return facts;
};

/** Say what the document is and which records it was linked to. */
export const reportUnderstanding = (
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
export const reportFacts = (
  emit: (event: IngestEvent) => void,
  facts: FactTally
) => {
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
