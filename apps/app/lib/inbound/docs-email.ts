// Documents emailed to the shop's docs-…@ address (docs/PRODUCT-PLAN.md
// F6.2): which attachments are read, and the reply listing what each one
// became. Pure, so tested; lib/inbound/docs.ts reads them.

import { DOCUMENT_TYPES, MAX_DOCUMENT_BYTES } from "../knowledge/types";

/** At most this many documents are read from one email. */
export const MAX_DOCS_PER_EMAIL = 10;

export interface DocAttachment {
  bytes: Uint8Array;
  name: string;
}

const extension = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
};

// Signatures and logos come as small inline images: not documents.
const MIN_IMAGE_BYTES = 20 * 1024;
const IMAGE = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** The attachments to read, and the ones left out with the reason. */
export const pickDocuments = (attachments: readonly DocAttachment[]) => {
  const read: DocAttachment[] = [];
  const left: string[] = [];
  for (const a of attachments) {
    const ext = extension(a.name);
    if (IMAGE.has(ext) && a.bytes.byteLength < MIN_IMAGE_BYTES) {
      continue;
    }
    if (!(DOCUMENT_TYPES as readonly string[]).includes(ext)) {
      left.push(`${a.name}: Takumo reads ${DOCUMENT_TYPES.join(", ")} files`);
    } else if (a.bytes.byteLength > MAX_DOCUMENT_BYTES) {
      left.push(`${a.name}: larger than 20 MB`);
    } else if (read.length >= MAX_DOCS_PER_EMAIL) {
      left.push(`${a.name}: up to ${MAX_DOCS_PER_EMAIL} documents per email`);
    } else {
      read.push(a);
    }
  }
  return { read, left };
};

/** What one document became. */
export type DocOutcome =
  | {
      facts: string[];
      linked: number;
      name: string;
      ok: true;
      passages: number;
      /** "Linked to: P-1001 rev A, HAAS VF-2" and the like. */
      steps: string[];
    }
  | { error: string; name: string; ok: false };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const LINKED_STEP = /^(Identified a|Linked to|Not in your records)/;

/** The reply email's text. */
export const docsReply = (input: {
  knowledgeUrl: string;
  factsUrl: string;
  left: string[];
  outcomes: DocOutcome[];
}) => {
  const lines: string[] = [];
  const done = input.outcomes.filter((o) => o.ok);
  if (input.outcomes.length === 0) {
    lines.push(
      "Takumo didn't find a document to read in your email. Attach a PDF, Word file, text file or photo of the document and send it again."
    );
  } else {
    lines.push(
      done.length === input.outcomes.length
        ? `Takumo read ${plural(done.length, "document")}. ${done.length === 1 ? "It's" : "They're"} on the Knowledge page now.`
        : `Takumo read ${done.length} of ${plural(input.outcomes.length, "document")}.`
    );
  }
  for (const o of input.outcomes) {
    lines.push("", o.name);
    if (!o.ok) {
      lines.push(`  Couldn't read it: ${o.error}`);
      continue;
    }
    for (const step of o.steps.filter((s) => LINKED_STEP.test(s))) {
      lines.push(`  ${step}`);
    }
    if (o.linked === 0) {
      lines.push("  Not linked to any part, machine, customer or material.");
    }
    lines.push(
      o.facts.length
        ? `  ${plural(o.facts.length, "fact")} proposed for review: ${o.facts.join(", ")}`
        : "  No new facts to review."
    );
  }
  if (input.left.length) {
    lines.push("", "Left out:", ...input.left.map((l) => `  ${l}`));
  }
  lines.push("", `Documents: ${input.knowledgeUrl}`);
  if (done.some((o) => o.ok && o.facts.length)) {
    lines.push(`Facts to review: ${input.factsUrl}`);
  }
  return lines.join("\n");
};
