import "server-only";

import type { LanguageModelUsage } from "@repo/ai";
import { generateText, Output } from "@repo/ai";
import { models } from "@repo/ai/lib/models";
import { z } from "zod";
import { ISO_DAY } from "../schedule/request";
import {
  matchCustomer,
  matchMaterial,
  matchPart,
  type Named,
  type PartLike,
} from "./match";
import { MAX_QTY_BREAKS } from "./types";

const lineSchema = z.object({
  partNo: z
    .string()
    .nullable()
    .describe("Part or drawing number exactly as written"),
  rev: z.string().nullable().describe("Revision, e.g. B"),
  description: z.string().nullable(),
  material: z
    .string()
    .nullable()
    .describe("Material as the customer wrote it, with stock form and size"),
  qtys: z
    .array(z.number().int().positive())
    .describe("Every quantity asked for, e.g. 50/100/250 → [50, 100, 250]"),
  tolerances: z.string().nullable(),
  finish: z
    .string()
    .nullable()
    .describe("Finish or outside processing: anodize, plating, heat treat…"),
  notes: z
    .string()
    .nullable()
    .describe("Other requirements for this part: certs, marking, packaging"),
  shopPart: z
    .string()
    .nullable()
    .describe("The matching shop part number from the list, or null"),
  shopMaterial: z
    .string()
    .nullable()
    .describe("The matching shop material name from the list, or null"),
});

const schema = z.object({
  isRfq: z
    .boolean()
    .describe("False when the text isn't a request for a quote at all"),
  customer: z
    .string()
    .nullable()
    .describe("The company asking for the quote (not our shop)"),
  shopCustomer: z
    .string()
    .nullable()
    .describe("The matching customer name from the shop's list, or null"),
  contact: z
    .string()
    .nullable()
    .describe("Person asking, with email or phone if given"),
  requestedDate: z
    .string()
    .nullable()
    .describe("Date the parts are needed by, YYYY-MM-DD"),
  notes: z
    .string()
    .nullable()
    .describe(
      "Requirements for the whole RFQ: certs, shipping, quote due date"
    ),
  lines: z.array(lineSchema),
  questions: z
    .array(z.string())
    .describe("What's missing or unclear that the estimator should ask"),
});

export type RfqReading = z.infer<typeof schema>;

export interface ShopLists {
  customers: Named[];
  materials: Named[];
  /** Shop parts whose number appears in the RFQ. */
  parts: PartLike[];
}

export interface ReadLine {
  description: string | null;
  finish: string | null;
  lineNo: number;
  materialId: string | null;
  materialText: string | null;
  notes: string | null;
  /** Another revision of the same part number in the shop. */
  otherRevPartId: string | null;
  partId: string | null;
  partNo: string | null;
  qtys: number[];
  rev: string | null;
  tolerances: string | null;
}

export interface ReadRfq {
  contact: string | null;
  customerId: string | null;
  customerName: string | null;
  isRfq: boolean;
  lines: ReadLine[];
  notes: string | null;
  questions: string[];
  reading: RfqReading;
  requestedDate: string | null;
  /** What the read cost (recorded by the caller, which knows the shop). */
  usage: { modelId: string; tokens: LanguageModelUsage };
}

const SYSTEM = `You read requests for quote (RFQs) sent to a CNC machining and fabrication job shop, from emails, PDFs and Word files, and turn them into structured lines for the shop's estimator.

Rules:
- Only record what the RFQ says. Never invent part numbers, quantities, materials, dates or requirements. Use null when something isn't stated.
- One line per distinct part (part number + revision). Quantity breaks for the same part ("50/100/250 pcs", "qty 25 and 100") go in that line's qtys, in the order written.
- partNo and rev exactly as written (drop words like "P/N" or "Dwg"). If only a drawing number is given, use it as partNo.
- material: as written, including stock form and size (e.g. "6061-T6 aluminum, 2 in round bar").
- finish: coatings and outside processes (anodize, passivate, powder coat, heat treat, plating). tolerances: tolerances, flatness, surface finish callouts.
- requestedDate: when the parts are needed (not when the quote is due), as YYYY-MM-DD. Resolve relative dates ("in 3 weeks", "by the 20th") from the date the RFQ was received. null if not stated.
- Matching: shopCustomer, shopPart and shopMaterial must be copied exactly from the shop's lists below, and only when you're confident it's the same thing. A different revision is not the same part. A different alloy or stock size is not the same material.
- questions: short questions for the customer about anything an estimator needs but the RFQ leaves out or makes ambiguous (missing quantity, material, revision, drawing). At most 4. None if it's complete.
- isRfq: false if the text isn't asking for a price at all.`;

const list = (label: string, items: string[]) =>
  items.length
    ? `${label}:\n${items.map((i) => `- ${i}`).join("\n")}`
    : `${label}: (none)`;

const cleanDate = (value: string | null) =>
  value && ISO_DAY.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : null;

const cleanText = (value: string | null) => {
  const text = value?.trim();
  return text ? text : null;
};

/**
 * Read an RFQ into lines with Claude, then check its matches against the
 * shop's records (a match the model makes up is dropped).
 */
export const extractRfq = async (
  text: string,
  receivedOn: string,
  shop: ShopLists
): Promise<ReadRfq> => {
  const { output, usage, response } = await generateText({
    model: models.extract,
    output: Output.object({ schema }),
    system: SYSTEM,
    prompt: `Received on: ${receivedOn}

${list(
  "Shop customers",
  shop.customers.map((c) => c.name)
)}

${list(
  "Shop parts mentioned in the RFQ (part number, rev)",
  shop.parts.map((p) => `${p.partNo} rev ${p.rev}`)
)}

${list(
  "Shop materials",
  shop.materials.map((m) => m.name)
)}

RFQ:
<rfq>
${text}
</rfq>`,
  });
  if (!output) {
    throw new Error("Takumo couldn't read this RFQ. Try again.");
  }

  const exactName = (name: string | null, items: Named[]) =>
    name ? (items.find((i) => i.name === name) ?? null) : null;
  const customer =
    exactName(output.shopCustomer, shop.customers) ??
    matchCustomer(output.customer, shop.customers);

  const lines: ReadLine[] = output.lines
    .filter((l) => l.partNo || l.description)
    .map((line, index) => {
      const suggested = line.shopPart
        ? shop.parts.filter((p) => p.partNo === line.shopPart)
        : [];
      const matched = matchPart(line.partNo, line.rev, shop.parts);
      // The model's pick only counts if it agrees on the revision too.
      const confirmed =
        matched.part ??
        (suggested.length === 1 &&
        (!line.rev ||
          suggested[0].rev.toLowerCase() === line.rev.trim().toLowerCase())
          ? suggested[0]
          : null);
      const material =
        exactName(line.shopMaterial, shop.materials) ??
        matchMaterial(line.material, shop.materials);
      return {
        lineNo: index + 1,
        partNo: cleanText(line.partNo),
        rev: cleanText(line.rev),
        description: cleanText(line.description),
        materialText: cleanText(line.material),
        qtys: [...new Set(line.qtys)].slice(0, MAX_QTY_BREAKS),
        tolerances: cleanText(line.tolerances),
        finish: cleanText(line.finish),
        notes: cleanText(line.notes),
        partId: confirmed?.id ?? null,
        otherRevPartId: confirmed ? null : (matched.otherRev?.id ?? null),
        materialId: material?.id ?? null,
      };
    });

  return {
    isRfq: output.isRfq,
    customerName: cleanText(output.customer),
    customerId: customer?.id ?? null,
    contact: cleanText(output.contact),
    requestedDate: cleanDate(output.requestedDate),
    notes: cleanText(output.notes),
    questions: output.questions.slice(0, 4),
    lines,
    reading: output,
    usage: { modelId: response.modelId, tokens: usage },
  };
};
