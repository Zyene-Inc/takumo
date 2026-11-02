import "server-only";

import { database, forOrg } from "@repo/database";
import type { OutsideProcess, QuoteOperation } from "@repo/engine-client/types";
import { approvalProblems, finalFor } from "./approval";
import { matchPart } from "./match";
import {
  type DrawingReading,
  type LineDraft,
  type LineFinal,
  type QuotedBreak,
  type RfqReply,
  type RfqStatus,
  rfqLabel,
} from "./types";

const num = (value: { toString(): string } | null) =>
  value === null ? null : Number(value.toString());

const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

/** Everything the RFQ page shows, as plain data for the browser. */
export const loadRfqView = async (orgId: string, rfqId: string) => {
  const db = forOrg(database, orgId);
  const rfq = await db.rfq.findFirst({
    where: { id: rfqId },
    include: {
      customer: { select: { name: true, paymentTermDays: true } },
      lines: {
        orderBy: { lineNo: "asc" },
        include: {
          part: { select: { id: true, partNo: true, rev: true } },
          material: {
            select: {
              id: true,
              name: true,
              unit: true,
              unitCost: true,
              leadTimeDays: true,
            },
          },
          quote: {
            select: {
              id: true,
              quoteNo: true,
              status: true,
              breaks: true,
              quotedAt: true,
            },
          },
        },
      },
    },
  });
  if (!rfq) {
    return null;
  }
  const parts = await db.part.findMany({
    select: { id: true, partNo: true, rev: true },
  });
  const extracted = rfq.extracted as { questions?: string[] } | null;
  const lines = rfq.lines.map((line) => {
    const otherRev = line.part
      ? null
      : matchPart(line.partNo, line.rev, parts).otherRev;
    return {
      id: line.id,
      lineNo: line.lineNo,
      partNo: line.partNo,
      rev: line.rev,
      description: line.description,
      materialText: line.materialText,
      qtys: line.qtys,
      tolerances: line.tolerances,
      finish: line.finish,
      notes: line.notes,
      part: line.part,
      otherRev: otherRev ? `${otherRev.partNo} rev ${otherRev.rev}` : null,
      material: line.material
        ? {
            ...line.material,
            unitCost: num(line.material.unitCost),
          }
        : null,
      routing: line.routing as QuoteOperation[] | null,
      outside: line.outside as OutsideProcess[] | null,
      usagePerPart: line.usagePerPart,
      materialCost: line.materialCost,
      targetMargin: line.targetMargin,
      draft: line.draft as LineDraft | null,
      drawing: (line.drawing as DrawingReading | null) ?? null,
      final: (line.final as LineFinal | null) ?? null,
      sendFinal: finalFor(line),
      quote: line.quote
        ? {
            id: line.quote.id,
            quoteNo: line.quote.quoteNo,
            status: line.quote.status,
            breaks: (line.quote.breaks as QuotedBreak[] | null) ?? [],
            quotedAt: line.quote.quotedAt.toISOString().slice(0, 10),
          }
        : null,
      orderNo: (line.final as LineFinal | null)?.orderNo ?? null,
    };
  });
  return {
    id: rfq.id,
    label: rfqLabel(rfq.number),
    status: rfq.status as RfqStatus,
    source: rfq.source,
    subject: rfq.subject,
    sender: rfq.sender,
    fileName: rfq.fileName,
    body: rfq.body,
    receivedAt: rfq.receivedAt.toISOString(),
    customerName: rfq.customer?.name ?? rfq.customerName,
    customerKnown: Boolean(rfq.customer),
    paymentTermDays: rfq.customer?.paymentTermDays ?? null,
    contact: rfq.contact,
    requestedDate: day(rfq.requestedDate),
    notes: rfq.notes,
    error: rfq.error,
    questions: extracted?.questions ?? [],
    problems: approvalProblems(rfq),
    reply: (rfq.reply as RfqReply | null) ?? null,
    draftedAt: rfq.draftedAt?.toISOString() ?? null,
    sentAt: rfq.sentAt?.toISOString() ?? null,
    lines,
  };
};

export type RfqView = NonNullable<Awaited<ReturnType<typeof loadRfqView>>>;
export type LineView = RfqView["lines"][number];
