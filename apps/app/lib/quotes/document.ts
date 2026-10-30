import type { QuoteDocument } from "./pdf";
import type { ReplyLine } from "./reply";
import type { RfqView } from "./view";

const DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const fmt = (isoDay: string) => DATE.format(new Date(`${isoDay}T00:00:00Z`));

/** The quoted lines, as sent: quote number, part and every quantity. */
export const quotedLines = (
  rfq: RfqView
): (ReplyLine & { line: RfqView["lines"][number] })[] =>
  rfq.lines.flatMap((line) =>
    line.quote
      ? [
          {
            line,
            quoteNo: line.quote.quoteNo,
            partNo: line.partNo ?? line.part?.partNo ?? `Line ${line.lineNo}`,
            rev: line.rev ?? line.part?.rev ?? null,
            breaks: line.quote.breaks,
          },
        ]
      : []
  );

/** "Q-9009" or "Q-9009 – Q-9011" for a multi-line RFQ. */
export const quoteReference = (quoteNos: string[]) =>
  quoteNos.length > 1
    ? `${quoteNos[0]} – ${quoteNos.at(-1)}`
    : (quoteNos[0] ?? "");

export const quoteDocument = (rfq: RfqView, shop: string): QuoteDocument => {
  const lines = quotedLines(rfq);
  const notes = [
    rfq.subject ? `Your reference: ${rfq.subject}` : null,
    `Our reference: ${rfq.label}`,
    ...rfq.lines
      .filter((l) => l.quote && l.tolerances)
      .map(
        (l) => `${l.partNo ?? `Line ${l.lineNo}`}: quoted to ${l.tolerances}.`
      ),
  ].filter((n): n is string => Boolean(n));
  return {
    shop,
    reference: quoteReference(lines.map((l) => l.quoteNo)),
    date: fmt(lines[0]?.line.quote?.quotedAt ?? rfq.receivedAt.slice(0, 10)),
    customer: rfq.customerName ?? "—",
    contact: rfq.contact,
    paymentTerms: rfq.paymentTermDays ? `Net ${rfq.paymentTermDays}` : null,
    requestedDate: rfq.requestedDate ? fmt(rfq.requestedDate) : null,
    lines: lines.map((l) => ({
      quoteNo: l.quoteNo,
      partNo: l.partNo,
      rev: l.rev,
      description: l.line.description,
      material: l.line.material?.name ?? l.line.materialText,
      finish: l.line.finish,
      breaks: l.breaks.map((b) => ({
        qty: b.qty,
        unitPrice: b.unitPrice,
        price: Math.round(b.unitPrice * b.qty * 100) / 100,
        leadTimeDays: b.leadTimeDays,
      })),
    })),
    notes,
  };
};
