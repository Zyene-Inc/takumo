import "server-only";

import { database, forOrg } from "@repo/database";
import { log } from "@repo/observability/log";
import { closeRfqWhenAnswered } from "./approve";
import { settleQuotes, WIN_WINDOW_DAYS } from "./outcomes";
import type { LineFinal, QuotedBreak } from "./types";

const DAY_MS = 86_400_000;

/**
 * Mark open quotes won or lost from the shop's ERP orders (F2.7-R1). Runs
 * after an orders report imports and once a day. Never throws; returns how
 * many quotes it settled.
 */
export const settleFromErp = async (orgId: string, now = new Date()) => {
  try {
    const db = forOrg(database, orgId);
    const quotes = await db.quote.findMany({
      where: { status: "open", rfqId: { not: null } },
      select: {
        id: true,
        partId: true,
        customerId: true,
        quotedAt: true,
        qty: true,
        breaks: true,
        rfq: { select: { id: true, sentAt: true } },
      },
    });
    if (quotes.length === 0) {
      return { won: 0, lost: 0 };
    }
    const oldest = Math.min(
      ...quotes.map((q) => (q.rfq?.sentAt ?? q.quotedAt).getTime())
    );
    const [orders, feed, first] = await Promise.all([
      db.order.findMany({
        where: {
          syncedAt: { not: null },
          createdAt: {
            gte: new Date(oldest),
            lte: new Date(oldest + 400 * DAY_MS),
          },
        },
        select: {
          orderNo: true,
          partId: true,
          customerId: true,
          qty: true,
          createdAt: true,
        },
      }),
      db.erpReport.count({ where: { entity: "orders", status: "active" } }),
      db.order.aggregate({
        where: { syncedAt: { not: null } },
        _min: { createdAt: true },
      }),
    ]);
    const result = settleQuotes(
      quotes.map((q) => ({
        id: q.id,
        partId: q.partId,
        customerId: q.customerId,
        since: q.rfq?.sentAt ?? q.quotedAt,
      })),
      orders,
      now,
      feed > 0,
      first._min.createdAt
    );
    const byId = new Map(quotes.map((q) => [q.id, q]));
    let won = 0;
    for (const w of result.won) {
      const quote = byId.get(w.quoteId);
      if (!quote) {
        continue;
      }
      const breaks = (quote.breaks as QuotedBreak[] | null) ?? [];
      const chosen = breaks.find((b) => b.qty === w.qty);
      await database.$transaction(async (tx) => {
        const closed = await tx.quote.updateMany({
          where: { id: quote.id, orgId, status: "open" },
          data: {
            status: "won",
            // The ordered quantity's quoted price, when it was one of them.
            ...(chosen
              ? {
                  qty: chosen.qty,
                  price: chosen.price,
                  leadTimeDays: chosen.leadTimeDays,
                }
              : {}),
          },
        });
        if (closed.count === 0) {
          return;
        }
        won += 1;
        const line = await tx.rfqLine.findFirst({
          where: { orgId, quoteId: quote.id },
          select: { id: true, final: true },
        });
        if (line) {
          await tx.rfqLine.update({
            where: { id: line.id },
            data: {
              final: {
                ...((line.final as LineFinal | null) ?? {}),
                orderNo: w.orderNo,
              },
            },
          });
        }
        if (quote.rfq) {
          await closeRfqWhenAnswered(tx, orgId, quote.rfq.id);
        }
      });
    }
    let lost = 0;
    for (const id of result.lost) {
      const quote = byId.get(id);
      await database.$transaction(async (tx) => {
        const closed = await tx.quote.updateMany({
          where: { id, orgId, status: "open" },
          data: { status: "lost" },
        });
        if (closed.count === 0) {
          return;
        }
        lost += 1;
        if (quote?.rfq) {
          await closeRfqWhenAnswered(tx, orgId, quote.rfq.id);
        }
      });
    }
    return { won, lost };
  } catch (error) {
    log.warn("Settling quotes from the ERP failed", {
      orgId,
      error: String(error),
    });
    return { won: 0, lost: 0 };
  }
};

/** Every shop whose ERP sends open orders (the daily check). */
export const settleAllFromErp = async (now = new Date()) => {
  const shops = await database.erpReport.findMany({
    where: { entity: "orders", status: "active" },
    distinct: ["orgId"],
    select: { orgId: true },
  });
  let won = 0;
  let lost = 0;
  for (const { orgId } of shops) {
    const r = await settleFromErp(orgId, now);
    won += r.won;
    lost += r.lost;
  }
  return { shops: shops.length, won, lost, windowDays: WIN_WINDOW_DAYS };
};
