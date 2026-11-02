import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import { erpFeeds, fedByErp } from "../erp/feeds";
import { approvalProblems, finalFor } from "./approval";
import { matchCustomer } from "./match";
import { nextNumber } from "./numbers";
import type {
  ErpOrderEntry,
  LineDraft,
  LineFinal,
  QuotedBreak,
  RfqReply,
} from "./types";

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

const DAY_MS = 86_400_000;

const addDays = (isoDay: string, days: number) =>
  new Date(Date.parse(`${isoDay}T00:00:00Z`) + days * DAY_MS);

const NUMBER_RETRIES = 5;

/** The number the draft reply already carries, when it's still free. */
const quoteNumber = (kept: string | undefined, taken: string[]) =>
  kept && !taken.includes(kept) ? kept : nextNumber(taken, "Q-0001");

/** Another request changed the RFQ or quote first (a double click, a colleague). */
class AlreadyDone extends Error {}

/**
 * Run a transaction again when a request running at the same time took the
 * quote or order number it picked.
 */
const retryOnNumberClash = async <T>(run: () => Promise<T>) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const clash =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002";
      if (!clash || attempt >= NUMBER_RETRIES) {
        throw error;
      }
    }
  }
};

type Tx = Prisma.TransactionClient;

/**
 * The part a line quotes when it isn't one the shop has: an existing part
 * with that number and revision, or a new one with the estimated operations.
 */
const partForLine = async (
  tx: Tx,
  orgId: string,
  line: {
    partNo: string | null;
    rev: string | null;
    description: string | null;
    materialId: string | null;
  },
  draft: LineDraft,
  customerId: string | null,
  wcId: Map<string, string>
) => {
  const partNo = (line.partNo ?? "").trim();
  const rev = line.rev?.trim() || "A";
  const existing = await tx.part.findFirst({
    where: { orgId, partNo, rev },
    select: { id: true },
  });
  if (existing) {
    return existing.id;
  }
  const routings = draft.inputs.routing.flatMap((op) => {
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
  });
  const part = await tx.part.create({
    data: {
      orgId,
      partNo,
      rev,
      description: line.description,
      customerId,
      materialId: line.materialId,
      routings: { create: routings },
    },
    select: { id: true },
  });
  return part.id;
};

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

  const [customers, workCenters] = await Promise.all([
    db.customer.findMany({ select: { id: true, name: true } }),
    db.workCenter.findMany({ select: { id: true, name: true } }),
  ]);
  const wcId = new Map(workCenters.map((w) => [w.name, w.id]));

  const approve = () =>
    database.$transaction(async (tx) => {
      // Claim the RFQ first, so a second click (or a colleague) can't quote it twice.
      const claimed = await tx.rfq.updateMany({
        where: { id: rfq.id, orgId, status: { in: ["review", "drafted"] } },
        data: { status: "quoted" },
      });
      if (claimed.count === 0) {
        throw new AlreadyDone();
      }
      const taken = (
        await tx.quote.findMany({ where: { orgId }, select: { quoteNo: true } })
      ).map((q) => q.quoteNo);

      let customerId =
        rfq.customerId ??
        matchCustomer(rfq.customerName, customers)?.id ??
        null;
      if (!customerId && rfq.customerName) {
        customerId = (
          await tx.customer.create({
            data: { orgId, name: rfq.customerName.trim() },
            select: { id: true },
          })
        ).id;
      }

      // The numbers the draft reply and its PDF already carry, when free.
      const reserved = (rfq.reply as RfqReply | null)?.quoteNos ?? {};
      const made: string[] = [];
      for (const line of rfq.lines) {
        const draft = line.draft as unknown as LineDraft;
        const final = finalFor(line) as LineFinal;
        const partId =
          line.partId ??
          (await partForLine(tx, orgId, line, draft, customerId, wcId));

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
        const headline =
          breaks.find((b) => b.qty === line.qtys[0]) ?? breaks[0];
        const drafted = draft.response.breaks.find(
          (d) => d.qty === headline.qty
        );
        const quoteNo = quoteNumber(reserved[line.id], taken);
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
      await tx.rfq.update({ where: { id: rfq.id }, data: { customerId } });
      return made;
    });
  try {
    return { ok: true, quoteNos: await retryOnNumberClash(approve) };
  } catch (error) {
    if (error instanceof AlreadyDone) {
      return {
        ok: false,
        error: "This RFQ has already been quoted or closed.",
      };
    }
    throw error;
  }
};

/** Once every quote on an RFQ is answered, the RFQ is won (any won) or lost. */
export const closeRfqWhenAnswered = async (
  tx: Tx,
  orgId: string,
  rfqId: string
) => {
  const quotes = await tx.quote.findMany({
    where: { orgId, rfqId },
    select: { status: true },
  });
  if (quotes.every((q) => q.status !== "open")) {
    await tx.rfq.update({
      where: { id: rfqId },
      data: {
        status: quotes.some((q) => q.status === "won") ? "won" : "lost",
        decidedAt: new Date(),
      },
    });
  }
};

export type Outcome = { lineId: string } & (
  | { status: "won"; qty: number }
  | { status: "lost" }
);

interface Won {
  chosen: QuotedBreak;
  line: {
    description: string | null;
    final: unknown;
    id: string;
    partNo: string | null;
    rev: string | null;
  };
  quote: {
    customerId: string | null;
    partId: string | null;
    quoteNo: string;
  };
  today: string;
}

const withFinal = (line: Won["line"], extra: object) => ({
  ...((line.final as object | null) ?? {}),
  ...extra,
});

/**
 * The ERP is where orders are entered: lay the won quote out for that instead
 * of making a second copy here. The next orders report brings it back.
 */
const layOutForErp = async (tx: Tx, orgId: string, won: Won) => {
  const { quote, line, chosen, today } = won;
  const part = quote.partId
    ? await tx.part.findFirst({
        where: { id: quote.partId, orgId },
        select: { partNo: true, rev: true, description: true },
      })
    : null;
  const customer = quote.customerId
    ? await tx.customer.findFirst({
        where: { id: quote.customerId, orgId },
        select: { name: true },
      })
    : null;
  const erpOrder: ErpOrderEntry = {
    customer: customer?.name ?? null,
    partNo: part?.partNo ?? line.partNo ?? "",
    rev: part?.rev ?? line.rev,
    description: part?.description ?? line.description,
    qty: chosen.qty,
    unitPrice: chosen.unitPrice,
    dueDate: addDays(today, chosen.leadTimeDays).toISOString().slice(0, 10),
    quoteNo: quote.quoteNo,
  };
  await tx.rfqLine.update({
    where: { id: line.id },
    data: { final: withFinal(line, { erpOrder }) },
  });
};

/** No ERP feed for orders: the won quote becomes an open order in Takumo. */
const makeOrder = async (tx: Tx, orgId: string, won: Won) => {
  const { quote, line, chosen, today } = won;
  const orders = await tx.order.findMany({
    where: { orgId },
    select: { orderNo: true },
  });
  const made = nextNumber(
    orders.map((o) => o.orderNo),
    "SO-0001"
  );
  await tx.order.create({
    data: {
      orgId,
      orderNo: made,
      customerId: quote.customerId,
      partId: quote.partId as string,
      qty: chosen.qty,
      price: chosen.price,
      dueDate: addDays(today, chosen.leadTimeDays),
    },
  });
  await tx.rfqLine.update({
    where: { id: line.id },
    data: { final: withFinal(line, { orderNo: made }) },
  });
  return made;
};

/** The quote takes the quantity the customer chose. */
const keepChosen = (tx: Tx, quoteId: string, chosen: QuotedBreak) =>
  tx.quote.update({
    where: { id: quoteId },
    data: {
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

/**
 * The customer's answer for one line. Won: the quote takes the chosen
 * quantity. When the ERP sends the shop's orders, the order is laid out for
 * entering there (LineFinal.erpOrder); otherwise it becomes an open order in
 * Takumo, due the quoted lead time from today.
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
  const ordersFromErp = fedByErp(await erpFeeds(orgId), "orders");
  const chosen =
    outcome.status === "won"
      ? breaks.find((b) => b.qty === outcome.qty)
      : undefined;
  if (outcome.status === "won" && !(chosen && quote.partId)) {
    return { ok: false, error: "Pick one of the quoted quantities." };
  }

  const record = () =>
    database.$transaction(async (tx) => {
      // Close the quote first, so a second click can't make a second order.
      const closed = await tx.quote.updateMany({
        where: { id: quote.id, orgId, status: "open" },
        data: { status: chosen ? "won" : "lost" },
      });
      if (closed.count === 0) {
        throw new AlreadyDone();
      }
      let made: string | null = null;
      if (chosen && quote.partId) {
        if (ordersFromErp) {
          await layOutForErp(tx, orgId, { quote, line, chosen, today });
        } else {
          made = await makeOrder(tx, orgId, { quote, line, chosen, today });
        }
        await keepChosen(tx, quote.id, chosen);
      }
      await closeRfqWhenAnswered(tx, orgId, rfqId);
      return made;
    });
  try {
    return { ok: true, orderNo: await retryOnNumberClash(record) };
  } catch (error) {
    if (error instanceof AlreadyDone) {
      return {
        ok: false,
        error: `${quote.quoteNo} has already been answered.`,
      };
    }
    throw error;
  }
};
