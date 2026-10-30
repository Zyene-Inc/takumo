import "server-only";

import { database, forOrg } from "@repo/database";
import { approvalProblems, finalFor } from "./approval";
import { matchCustomer } from "./match";
import { nextNumber } from "./numbers";
import type { LineDraft, LineFinal, QuotedBreak } from "./types";

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

const DAY_MS = 86_400_000;

const addDays = (isoDay: string, days: number) =>
  new Date(Date.parse(`${isoDay}T00:00:00Z`) + days * DAY_MS);

/**
 * Approve an RFQ: one quote per line (every quantity on it), with the draft
 * kept beside what was sent. Parts the shop hasn't made are added with the
 * estimated operations (marked assumed), and a new customer is added.
 */
export const approveRfq = async (
  orgId: string,
  userId: string,
  rfqId: string
): Promise<Result<{ quoteNos: string[] }>> => {
  const db = forOrg(database, orgId);
  const rfq = await db.rfq.findFirst({
    where: { id: rfqId },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!rfq) {
    return { ok: false, error: "That RFQ no longer exists." };
  }
  if (!["review", "drafted"].includes(rfq.status)) {
    return { ok: false, error: "This RFQ has already been quoted or closed." };
  }
  const problems = approvalProblems(rfq);
  if (problems.length) {
    return { ok: false, error: problems.join(" ") };
  }

  const [customers, workCenters, quoteNos] = await Promise.all([
    db.customer.findMany({ select: { id: true, name: true } }),
    db.workCenter.findMany({ select: { id: true, name: true } }),
    db.quote.findMany({ select: { quoteNo: true } }),
  ]);
  const wcId = new Map(workCenters.map((w) => [w.name, w.id]));
  const taken = quoteNos.map((q) => q.quoteNo);

  const created = await database.$transaction(async (tx) => {
    let customerId =
      rfq.customerId ?? matchCustomer(rfq.customerName, customers)?.id ?? null;
    if (!customerId && rfq.customerName) {
      customerId = (
        await tx.customer.create({
          data: { orgId, name: rfq.customerName.trim() },
          select: { id: true },
        })
      ).id;
    }

    const made: string[] = [];
    for (const line of rfq.lines) {
      const draft = line.draft as unknown as LineDraft;
      const final = finalFor(line) as LineFinal;
      const partNo = (line.partNo ?? "").trim();
      const rev = line.rev?.trim() || "A";

      let partId = line.partId;
      if (!partId) {
        const existing = await tx.part.findFirst({
          where: { orgId, partNo, rev },
          select: { id: true },
        });
        partId =
          existing?.id ??
          (
            await tx.part.create({
              data: {
                orgId,
                partNo,
                rev,
                description: line.description,
                customerId,
                materialId: line.materialId,
                routings: {
                  create: draft.inputs.routing.flatMap((op) => {
                    const workCenterId = wcId.get(op.work_center);
                    return workCenterId
                      ? [
                          {
                            orgId,
                            seq: op.seq,
                            workCenterId,
                            setupMin: op.setup_min,
                            runMinPerUnit: op.run_min_per_unit,
                            altWorkCenterIds: (op.alt_work_centers ?? [])
                              .map((n) => wcId.get(n))
                              .filter((id): id is string => Boolean(id)),
                            // Estimated for the quote, not proven on the floor.
                            provenance: "assumed" as const,
                            confidence: 0.5,
                          },
                        ]
                      : [];
                  }),
                },
              },
              select: { id: true },
            })
          ).id;
      }

      const breaks: QuotedBreak[] = final.breaks.map((b) => {
        const drafted = draft.response.breaks.find((d) => d.qty === b.qty);
        return {
          qty: b.qty,
          unitPrice: b.unitPrice,
          price: Math.round(b.unitPrice * b.qty * 100) / 100,
          leadTimeDays: b.leadTimeDays,
          cost: drafted?.cost ?? null,
          draftUnitPrice: drafted?.unit_price ?? null,
          draftLeadTimeDays: drafted?.lead_time_days ?? null,
        };
      });
      // The quote's headline quantity: the first one the customer asked for.
      const headline = breaks.find((b) => b.qty === line.qtys[0]) ?? breaks[0];
      const drafted = draft.response.breaks.find((d) => d.qty === headline.qty);
      const quoteNo = nextNumber(taken, "Q-0001");
      taken.push(quoteNo);
      const quote = await tx.quote.create({
        data: {
          orgId,
          quoteNo,
          customerId,
          partId,
          qty: headline.qty,
          price: headline.price,
          leadTimeDays: headline.leadTimeDays,
          estCost: drafted?.cost ?? null,
          draftPrice: drafted?.price ?? null,
          draftLeadTimeDays: drafted?.lead_time_days ?? null,
          breaks: breaks as object[],
          status: "open",
          rfqId: rfq.id,
          approvedBy: userId,
        },
        select: { id: true },
      });
      await tx.rfqLine.update({
        where: { id: line.id },
        data: { partId, quoteId: quote.id, final: final as object },
      });
      made.push(quoteNo);
    }
    await tx.rfq.update({
      where: { id: rfq.id },
      data: { status: "quoted", customerId },
    });
    return made;
  });
  return { ok: true, quoteNos: created };
};

export type Outcome = { lineId: string } & (
  | { status: "won"; qty: number }
  | { status: "lost" }
);

/**
 * The customer's answer for one line. Won: the quote takes the chosen
 * quantity and becomes an open order, due the quoted lead time from today.
 */
export const recordOutcome = async (
  orgId: string,
  rfqId: string,
  outcome: Outcome,
  today: string
): Promise<Result<{ orderNo: string | null }>> => {
  const db = forOrg(database, orgId);
  const line = await db.rfqLine.findFirst({
    where: { id: outcome.lineId, rfqId },
    include: { quote: true, rfq: { select: { status: true } } },
  });
  if (!line?.quote) {
    return { ok: false, error: "That line hasn't been quoted." };
  }
  if (line.quote.status !== "open") {
    return {
      ok: false,
      error: `${line.quote.quoteNo} is already ${line.quote.status}.`,
    };
  }
  const quote = line.quote;
  const breaks = (quote.breaks as QuotedBreak[] | null) ?? [];
  const chosen =
    outcome.status === "won"
      ? breaks.find((b) => b.qty === outcome.qty)
      : undefined;
  if (outcome.status === "won" && !(chosen && quote.partId)) {
    return { ok: false, error: "Pick one of the quoted quantities." };
  }

  const orderNo = await database.$transaction(async (tx) => {
    let made: string | null = null;
    if (chosen && quote.partId) {
      const orders = await tx.order.findMany({
        where: { orgId },
        select: { orderNo: true },
      });
      made = nextNumber(
        orders.map((o) => o.orderNo),
        "SO-0001"
      );
      await tx.order.create({
        data: {
          orgId,
          orderNo: made,
          customerId: quote.customerId,
          partId: quote.partId,
          qty: chosen.qty,
          price: chosen.price,
          dueDate: addDays(today, chosen.leadTimeDays),
        },
      });
      await tx.rfqLine.update({
        where: { id: line.id },
        data: {
          final: { ...((line.final as object | null) ?? {}), orderNo: made },
        },
      });
      await tx.quote.update({
        where: { id: quote.id },
        data: {
          status: "won",
          qty: chosen.qty,
          price: chosen.price,
          leadTimeDays: chosen.leadTimeDays,
          estCost: chosen.cost,
          // Keep the draft comparable with what the customer accepted.
          draftPrice:
            chosen.draftUnitPrice === null
              ? null
              : Math.round(chosen.draftUnitPrice * chosen.qty * 100) / 100,
          draftLeadTimeDays: chosen.draftLeadTimeDays,
        },
      });
    } else {
      await tx.quote.update({
        where: { id: quote.id },
        data: { status: "lost" },
      });
    }
    const quotes = await tx.quote.findMany({
      where: { orgId, rfqId },
      select: { status: true },
    });
    if (quotes.every((q) => q.status !== "open")) {
      await tx.rfq.update({
        where: { id: rfqId },
        data: {
          status: quotes.some((q) => q.status === "won") ? "won" : "lost",
        },
      });
    }
    return made;
  });
  return { ok: true, orderNo };
};
