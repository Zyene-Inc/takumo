// What has to be true before an RFQ can be approved. Pure, so tested.

import { startingFinal } from "./numbers";
import type { LineDraft, LineFinal } from "./types";

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
