import type { QuoteDocument } from "./pdf";
import { type DraftReplyLine, draftReply, type ReplyLine } from "./reply";
import type { QuoteSettings } from "./types";
import type { RfqView } from "./view";

const DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const fmt = (isoDay: string) => DATE.format(new Date(`${isoDay}T00:00:00Z`));

/**
 * The quoted lines: quote number, part and every quantity. Approved lines use
 * their quote; with `reserved` numbers (a draft reply, before approval) the
 * other lines use the prices the estimator will send.
 */
export const quotedLines = (
  rfq: RfqView,
  reserved: Record<string, string> | null = null
): (ReplyLine & { line: RfqView["lines"][number] })[] =>
  rfq.lines.flatMap((line) => {
    const partNo = line.partNo ?? line.part?.partNo ?? `Line ${line.lineNo}`;
    const rev = line.rev ?? line.part?.rev ?? null;
    if (line.quote) {
      return [
        {
          line,
          quoteNo: line.quote.quoteNo,
          partNo,
          rev,
          breaks: line.quote.breaks,
        },
      ];
    }
    const quoteNo = reserved?.[line.id];
    return quoteNo && line.sendFinal
      ? [{ line, quoteNo, partNo, rev, breaks: line.sendFinal.breaks }]
      : [];
  });

/** The quoted lines as the reply email lists them, with what they assume. */
const draftReplyLines = (
  quoted: ReturnType<typeof quotedLines>
): DraftReplyLine[] =>
  quoted.map(({ line, ...l }) => ({
    ...l,
    material:
      line.material?.name ??
      line.materialText ??
      line.drawing?.material?.text ??
      null,
    finish:
      line.finish ??
      (line.drawing?.finishes?.map((f) => f.text).join("; ") || null),
    tolerances: line.tolerances,
    questions: line.drawing?.questions ?? [],
  }));

/** "Q-9009" or "Q-9009 – Q-9011" for a multi-line RFQ. */
const quoteReference = (quoteNos: string[]) =>
  quoteNos.length > 1
    ? `${quoteNos[0]} – ${quoteNos.at(-1)}`
    : (quoteNos[0] ?? "");

export const quoteDocument = (
  rfq: RfqView,
  shop: string,
  options: {
    reserved?: Record<string, string> | null;
    today?: string;
    validityDays?: number | null;
  } = {}
): QuoteDocument => {
  const lines = quotedLines(rfq, options.reserved ?? null);
  const notes = [
    rfq.subject ? `Your reference: ${rfq.subject}` : null,
    `Our reference: ${rfq.label}`,
    options.validityDays
      ? `Prices are valid for ${options.validityDays} days.`
      : null,
    ...lines
      .filter((l) => l.line.tolerances)
      .map((l) => `${l.partNo}: quoted to ${l.line.tolerances}.`),
  ].filter((n): n is string => Boolean(n));
  return {
    shop,
    reference: quoteReference(lines.map((l) => l.quoteNo)),
    date: fmt(
      lines[0]?.line.quote?.quotedAt ??
        options.today ??
        rfq.receivedAt.slice(0, 10)
    ),
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

/**
 * The reply to the customer for the lines that have prices: the draft put in
 * the mailbox and the preview on the RFQ page (one source, so they match).
 * Null when no line is priced yet.
 */
export const customerReply = (
  rfq: RfqView,
  shop: string,
  settings: Pick<
    QuoteSettings,
    "quoteValidityDays" | "replyIntro" | "signature"
  >,
  reserved: Record<string, string> | null
) => {
  const quoted = quotedLines(rfq, reserved);
  if (quoted.length === 0) {
    return null;
  }
  const lines = draftReplyLines(quoted);
  return {
    lines,
    ...draftReply({
      contact: rfq.contact ?? rfq.sender,
      subject: rfq.subject,
      shop,
      reference: quoteReference(lines.map((l) => l.quoteNo)),
      intro: settings.replyIntro,
      signature: settings.signature,
      validityDays: settings.quoteValidityDays,
      questions: rfq.questions,
      pdf: true,
      lines,
    }),
  };
};
