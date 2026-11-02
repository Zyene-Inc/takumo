import "server-only";

import { generateText, Output } from "@repo/ai";
import { models } from "@repo/ai/lib/models";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { recordFailedUsage, recordUsage } from "../ai-usage";
import { readDocument } from "../knowledge/read";
import { IMAGE_TYPES } from "../knowledge/types";
import type { IncomingFile } from "../quotes/attachments";
import { normalizePo } from "./normalize";

// Reads a customer's purchase order (the email and its PDF) into a header and
// lines. Scanned PDFs and photos are read from their page images first.

/** Characters of PO text sent to the model; POs are short. */
const MAX_CHARS = 40_000;
/** Less text than this means the PO is probably a scan: read the images. */
const MIN_TEXT = 200;

const lineSchema = z.object({
  partNo: z
    .string()
    .nullable()
    .describe("The customer's part or drawing number exactly as written"),
  rev: z.string().nullable().describe("Revision, e.g. C"),
  description: z.string().nullable(),
  qty: z.number().nullable().describe("Quantity ordered, in pieces"),
  unitPrice: z.number().nullable().describe("Price per piece"),
  extended: z.number().nullable().describe("Line total"),
  dueDate: z
    .string()
    .nullable()
    .describe("Date wanted / delivery date, as YYYY-MM-DD"),
});

const schema = z.object({
  isPo: z.boolean().describe("False if this isn't a purchase order at all"),
  poNo: z.string().nullable().describe("The purchase order number"),
  customerName: z
    .string()
    .nullable()
    .describe("The buying company (who issued the PO), not the supplier"),
  contact: z.string().nullable().describe("Buyer name and email"),
  orderDate: z.string().nullable().describe("PO date as YYYY-MM-DD"),
  shipTo: z.string().nullable().describe("Ship-to address, one line"),
  terms: z.string().nullable().describe("Payment terms, e.g. Net 30"),
  notes: z
    .string()
    .nullable()
    .describe("Requirements written on the PO: certs, inspection, packaging"),
  lines: z.array(lineSchema),
});

const SYSTEM = `You read a purchase order a customer sent to a machine shop (the supplier).
- Take every line item: part number and revision exactly as written, quantity, unit price, line total, due date.
- Dates as YYYY-MM-DD. Numbers without currency signs or commas.
- The customer is the company buying (who issued the PO), never the shop it's addressed to.
- Copy only what is written. Leave a field null rather than guess.`;

const isPdfOrImage = (name: string) => {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return ext === ".pdf" || (IMAGE_TYPES as readonly string[]).includes(ext);
};

/** The PO's text: the email and attachments, scans read from their images. */
const poText = async (orgId: string, body: string, files: IncomingFile[]) => {
  if (body.trim().length >= MIN_TEXT) {
    return body;
  }
  const parts = [body];
  for (const file of files.filter((f) => isPdfOrImage(f.name)).slice(0, 3)) {
    try {
      const read = await readDocument(orgId, file.name, file.bytes.slice());
      parts.push(
        `--- ${file.name} ---\n${read.pages.map((p) => p.text).join("\n\n")}`
      );
    } catch (error) {
      log.warn("Reading a PO file failed", { orgId, error: String(error) });
    }
  }
  return parts.join("\n\n");
};

export type ReadPo = ReturnType<typeof normalizePo> & { isPo: boolean };

/** Read a PO. Throws when the reading fails (the caller records why). */
export const extractPo = async (
  orgId: string,
  input: { body: string; files: IncomingFile[]; receivedOn: string }
): Promise<ReadPo> => {
  const text = (await poText(orgId, input.body, input.files)).slice(
    0,
    MAX_CHARS
  );
  try {
    const { output, usage, response } = await generateText({
      model: models.extract,
      output: Output.object({ schema }),
      system: SYSTEM,
      prompt: `Received on: ${input.receivedOn}\n\n${text}`,
    });
    await recordUsage(orgId, "po_read", response.modelId, usage);
    return { isPo: output.isPo, ...normalizePo(output) };
  } catch (error) {
    await recordFailedUsage(orgId, "po_read", error);
    throw error;
  }
};
