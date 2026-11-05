import "server-only";

import { generateText, Output } from "@repo/ai";
import { models } from "@repo/ai/lib/models";
import { database } from "@repo/database";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { recordFailedUsage, recordUsage } from "../ai-usage";
import type { Triage } from "./screen";

// The cheap "is this an RFQ?" check: the subject and the start of the email
// only, no attachments, the smallest model. A fraction of a cent, so the full
// reading (and its cost) is spent only on real requests.

/** Characters of the email body the check reads. */
const BODY_CHARS = 2000;
/** Checks per shop per day; past this, mail waits for a person instead. */
const DAILY_TRIAGE_LIMIT = 300;

const schema = z.object({
  kind: z
    .enum(["rfq", "po", "other"])
    .describe(
      "rfq: someone asks this shop for a price or quote on parts or work (an RFQ, RFP, quote request, re-quote, or a portal notice of a new RFQ). po: a customer sends a purchase order (an order to make parts, usually with a PO number). other: anything else"
    ),
  confidence: z.enum(["high", "medium", "low"]),
  summary: z
    .string()
    .describe(
      "One short line, under 15 words, on what the email is, e.g. 'Quote request for 3 machined brackets' or 'Invoice for October'"
    ),
});

const SYSTEM = `You sort a machine shop's incoming email into one of three kinds.
rfq: it asks the shop to quote a price for parts or work. Requests for quote, re-quotes, quote revisions and customer-portal notices of a new RFQ count.
po: a customer places an order with the shop: a purchase order (PO) for parts, often with a PO number, quantities and prices, usually as an attachment.
other: everything else, e.g. invoices, payment and shipping questions, order confirmations the shop sent, sales pitches, newsletters, job applications and internal chatter.
Judge only from what is given. If unsure, say so with low confidence.`;

const dayStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Whether the shop still has checks left today. */
const underLimit = async (orgId: string, now: Date) =>
  (await database.aiUsage.count({
    where: { orgId, feature: "rfq_triage", createdAt: { gte: dayStart(now) } },
  })) < DAILY_TRIAGE_LIMIT;

/**
 * Is this email an RFQ? null when the check didn't run (the daily limit, or
 * an error): the caller then leaves the decision to a person.
 */
export const triageEmail = async (
  orgId: string,
  email: { body: string; from: string | null; subject: string | null },
  now = new Date()
): Promise<Triage | null> => {
  if (!(await underLimit(orgId, now))) {
    log.info("RFQ triage daily limit reached", { orgId });
    return null;
  }
  try {
    const { output, usage, finalStep } = await generateText({
      model: models.extract,
      output: Output.object({ schema }),
      instructions: SYSTEM,
      prompt: `From: ${email.from ?? "(unknown)"}
Subject: ${email.subject ?? "(none)"}

${email.body.slice(0, BODY_CHARS)}`,
    });
    await recordUsage(orgId, "rfq_triage", finalStep.response.modelId, usage);
    return {
      isRfq: output.kind === "rfq",
      kind: output.kind,
      confidence: output.confidence,
      summary: output.summary.slice(0, 160),
    };
  } catch (error) {
    await recordFailedUsage(orgId, "rfq_triage", error);
    log.warn("RFQ triage failed", { orgId, error: String(error) });
    return null;
  }
};
