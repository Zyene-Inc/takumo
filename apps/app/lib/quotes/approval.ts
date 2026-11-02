// What has to be true before an RFQ can be approved. Pure, so tested.

import { startingFinal } from "./numbers";
import type { LineDraft, LineFinal, SentPrice } from "./types";

/** The prices to send: the estimator's edits, else the draft's. */
export const finalFor = (line: { draft: unknown; final: unknown }) =>
  (line.final as LineFinal | null) ??
  (line.draft ? startingFinal((line.draft as LineDraft).response) : null);

/** Problems that stop an RFQ being approved, per line. */
export const approvalProblems = (rfq: {
  customerName: string | null;
  customerId: string | null;
  lines: {
    lineNo: number;
    partNo: string | null;
    qtys: number[];
    draft: unknown;
    final: unknown;
  }[];
}) => {
  const problems: string[] = [];
  if (!(rfq.customerId || rfq.customerName?.trim())) {
    problems.push("Add the customer.");
  }
  if (rfq.lines.length === 0) {
    problems.push("Add at least one line.");
  }
  for (const line of rfq.lines) {
    const final = finalFor(line);
    if (!line.partNo?.trim()) {
      problems.push(`Line ${line.lineNo}: add the part number.`);
    }
    if (!line.draft) {
      problems.push(`Line ${line.lineNo}: draft the quote first.`);
    } else if (!final) {
      problems.push(`Line ${line.lineNo}: enter a price for every quantity.`);
    } else if (
      final.breaks.length !== line.qtys.length ||
      final.breaks.some((b) => !(b.unitPrice > 0) || b.leadTimeDays < 0)
    ) {
      problems.push(
        `Line ${line.lineNo}: every quantity needs a price and a lead time.`
      );
    }
  }
  return problems;
};

/**
 * Line prices with what was sent laid over them: every quantity on the line
 * needs a sent price (or the line keeps no final and the RFQ isn't approved).
 */
export const sentFinal = (
  line: {
    draft: unknown;
    final: unknown;
    partNo: string | null;
    qtys: number[];
  },
  prices: SentPrice[]
): LineFinal | null => {
  const partNo = line.partNo?.trim().toLowerCase();
  const mine = prices.filter((p) => p.partNo.toLowerCase() === partNo);
  if (mine.length === 0) {
    return null;
  }
  const start = finalFor(line);
  const breaks = line.qtys.map((qty) => {
    const sent = mine.find((p) => p.qty === qty);
    const before = start?.breaks.find((b) => b.qty === qty);
    if (!sent) {
      return before ?? null;
    }
    return {
      qty,
      unitPrice: sent.unitPrice,
      leadTimeDays: sent.leadTimeDays ?? before?.leadTimeDays ?? null,
    };
  });
  if (breaks.some((b) => b === null || b.leadTimeDays === null)) {
    return null;
  }
  return {
    breaks: breaks as LineFinal["breaks"],
  };
};
