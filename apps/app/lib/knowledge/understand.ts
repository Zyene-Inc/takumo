import "server-only";

import { generateText, Output } from "@repo/ai";
import { models } from "@repo/ai/lib/models";
import { database, forOrg } from "@repo/database";
import { z } from "zod";
import { recordFailedUsage, recordUsage } from "../ai-usage";
import {
  type CatalogEntry,
  MENTION_TYPES,
  normalize,
  type Resolved,
  resolveMention,
} from "./resolve";

export const DOC_TYPES = [
  "setup_sheet",
  "sop",
  "work_instruction",
  "quality_manual",
  "customer_spec",
  "drawing",
  "traveler",
  "inspection_report",
  "purchase_order",
  "other",
] as const;

export const DOC_TYPE_LABEL: Record<(typeof DOC_TYPES)[number], string> = {
  setup_sheet: "setup sheet",
  sop: "SOP",
  work_instruction: "work instruction",
  quality_manual: "quality manual",
  customer_spec: "customer spec",
  drawing: "drawing",
  traveler: "traveler",
  inspection_report: "inspection report",
  purchase_order: "purchase order",
  other: "document",
};

/** How much of a document the reading calls see. */
const CARD_CHARS = 40_000;
const CONTEXT_DOC_CHARS = 30_000;
const CONTEXT_BATCH = 30;

const cardSchema = z.object({
  docType: z.enum(DOC_TYPES),
  title: z
    .string()
    .describe("The document's own title, or a short name for it"),
  revision: z
    .string()
    .nullable()
    .describe(
      'Its revision or version as printed ("B", "3", "2026-04"), or null'
    ),
  summary: z
    .string()
    .describe(
      "Two sentences at most: what it is and what it's for, in the shop's terms"
    ),
  mentions: z
    .array(
      z.object({
        type: z.enum(MENTION_TYPES),
        name: z
          .string()
          .describe(
            "The record's name exactly as in the shop's lists when it is one of them; otherwise as written"
          ),
        quote: z
          .string()
          .describe(
            "A short verbatim passage (under 200 characters) where it's named"
          ),
      })
    )
    .describe("Every part, machine, customer and material the document names"),
});

export type DocumentCard = z.infer<typeof cardSchema>;

const CARD_SYSTEM = `You read a machine shop's documents and say what each one is and which of the shop's records it's about.
- Types: setup_sheet, sop, work_instruction, quality_manual, customer_spec, drawing, traveler, inspection_report, purchase_order, other.
- mentions: every part, machine (work center), customer and material the document names, once each. When it matches the shop's lists below (even written differently: "P2001" for P-2001, "the VF2" for HAAS-VF2), use the list's exact name. Skip generic words ("the part", "the lathe") that don't name one record.
- quote: copy the words from the document; never paraphrase.`;

/** The shop's records, for matching names. */
export const loadCatalog = async (orgId: string) => {
  const db = forOrg(database, orgId);
  const [parts, machines, customers, materials] = await Promise.all([
    db.part.findMany({
      select: { id: true, partNo: true, rev: true, description: true },
    }),
    db.workCenter.findMany({ select: { id: true, name: true } }),
    db.customer.findMany({ select: { id: true, name: true } }),
    db.material.findMany({ select: { id: true, name: true, spec: true } }),
  ]);
  const catalog: CatalogEntry[] = [
    ...parts.map((p) => ({
      id: p.id,
      label: p.rev ? `${p.partNo} rev ${p.rev}` : p.partNo,
      rev: p.rev,
      type: "part" as const,
      keys: [normalize(p.partNo)],
    })),
    ...machines.map((m) => ({
      id: m.id,
      label: m.name,
      type: "machine" as const,
      keys: [normalize(m.name)],
    })),
    ...customers.map((c) => ({
      id: c.id,
      label: c.name,
      type: "customer" as const,
      keys: [normalize(c.name)],
    })),
    ...materials.map((m) => ({
      id: m.id,
      label: m.name,
      type: "material" as const,
      keys: [normalize(m.name), ...(m.spec ? [normalize(m.spec)] : [])],
    })),
  ];
  const lists = `Shop lists:
Parts: ${parts
    .map(
      (p) =>
        `${p.partNo}${p.rev ? ` rev ${p.rev}` : ""}${p.description ? ` (${p.description})` : ""}`
    )
    .join("; ")
    .slice(0, 20_000)}
Machines: ${machines.map((m) => m.name).join(", ")}
Customers: ${customers.map((c) => c.name).join(", ")}
Materials: ${materials.map((m) => (m.spec ? `${m.name} (${m.spec})` : m.name)).join(", ")}`;
  return { catalog, lists };
};

export interface Mention extends Resolved {
  quote: string;
}

export interface Understanding {
  card: DocumentCard;
  /** Mentions matched to the shop's records, one per record. */
  linked: Mention[];
  /** Names the document uses that match no record (or more than one). */
  unmatched: { name: string; type: string }[];
}

/** What a document is, and which of the shop's records it's about. */
export const understandDocument = async (
  orgId: string,
  name: string,
  text: string,
  shop: Awaited<ReturnType<typeof loadCatalog>>
): Promise<Understanding> => {
  let card: DocumentCard;
  try {
    const { output, usage, response } = await generateText({
      model: models.chat,
      output: Output.object({ schema: cardSchema }),
      system: CARD_SYSTEM,
      prompt: `${shop.lists}

Document "${name}":
<document>
${text.slice(0, CARD_CHARS)}
</document>`,
    });
    await recordUsage(orgId, "doc_read", response.modelId, usage);
    card = output;
  } catch (error) {
    await recordFailedUsage(orgId, "doc_read", error);
    throw error;
  }
  const linked = new Map<string, Mention>();
  const unmatched = new Map<string, { name: string; type: string }>();
  for (const m of card.mentions) {
    const found = resolveMention(m, shop.catalog);
    if (found) {
      if (!linked.has(found.id)) {
        linked.set(found.id, { ...found, quote: m.quote.slice(0, 300) });
      }
    } else {
      unmatched.set(`${m.type}:${normalize(m.name)}`, {
        name: m.name,
        type: m.type,
      });
    }
  }
  return {
    card,
    linked: [...linked.values()],
    unmatched: [...unmatched.values()],
  };
};

const contextSchema = z.object({
  contexts: z.array(
    z.object({
      n: z.number().int(),
      context: z.string(),
    })
  ),
});

/**
 * One sentence per passage placing it in its document (Anthropic's
 * "contextual retrieval"): indexed with the passage, so a search for
 * "P-2001 setup" finds a passage that only says "Op 20: 45 min".
 */
export const contextualize = async (
  orgId: string,
  doc: { name: string; summary: string; text: string },
  passages: string[]
) => {
  const out = new Array<string>(passages.length).fill("");
  const header = `Document "${doc.name}": ${doc.summary}
<document>
${doc.text.slice(0, CONTEXT_DOC_CHARS)}
</document>`;
  for (let start = 0; start < passages.length; start += CONTEXT_BATCH) {
    const batch = passages.slice(start, start + CONTEXT_BATCH);
    try {
      const { output, usage, response } = await generateText({
        model: models.extract,
        output: Output.object({ schema: contextSchema }),
        // The document comes first so each batch reuses the cached prefix.
        prompt: `${header}

For each numbered passage from this document, write one short sentence (under 30 words) that places it in the document: which part, operation, machine, customer or section it's about, so it can be found on its own. Don't repeat the passage.

${batch.map((p, i) => `[${start + i + 1}]\n${p.slice(0, 1500)}`).join("\n\n")}`,
      });
      await recordUsage(orgId, "doc_read", response.modelId, usage);
      for (const c of output.contexts) {
        if (c.n >= 1 && c.n <= passages.length) {
          out[c.n - 1] = c.context.trim().slice(0, 400);
        }
      }
    } catch (error) {
      // Passages stay searchable without their context sentence.
      await recordFailedUsage(orgId, "doc_read", error);
    }
  }
  return out;
};
