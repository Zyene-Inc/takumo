import { z } from "zod";

// What the Quoting settings form sends. Shared by the form and the action.

const money = z.number().min(0).max(100_000);

export const supplierSchema = z.object({
  process: z.string().trim().min(1, "Name the process").max(80),
  supplier: z.string().trim().max(80).nullable(),
  leadTimeDays: z.number().int().min(0).max(365).nullable(),
  costPerPart: money.nullable(),
  lotCharge: money.nullable(),
});

export const quoteSettingsSchema = z.object({
  quoteValidityDays: z.number().int().min(1).max(365),
  /** Percent, e.g. 15 for 15%. */
  materialMarkupPct: z.number().min(0).max(300),
  laborRate: z.number().min(0).max(1000),
  toleranceIn: z.number().min(0.000_01).max(0.1),
  certifications: z.array(z.string().trim().min(1).max(60)).max(30),
  outsideProcesses: z.array(supplierSchema).max(40),
  signature: z.string().trim().max(1000).nullable(),
  replyIntro: z.string().trim().max(1000).nullable(),
});

export type QuoteSettingsForm = z.infer<typeof quoteSettingsSchema>;

const LIST_SEPARATOR = /[\n,;]+/;

/** "AS9100, ITAR\nISO 9001" → ["AS9100", "ITAR", "ISO 9001"] */
export const splitList = (text: string) => [
  ...new Set(
    text
      .split(LIST_SEPARATOR)
      .map((s) => s.trim())
      .filter(Boolean)
  ),
];
