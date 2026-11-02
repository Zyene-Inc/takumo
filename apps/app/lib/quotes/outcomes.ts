// Quotes the ERP answers (docs/PRODUCT-PLAN.md F2.7-R1): an order for the
// same part and customer within 60 days of the quote going out means it was
// won; 60 days with none, while the shop's ERP sends its open orders, means
// it was lost. Pure, so tested; lib/quotes/settle.ts applies it.

const DAY_MS = 86_400_000;
export const WIN_WINDOW_DAYS = 60;
/** Orders created this soon after the ERP feed started came with its first
 * import: they were already open, not answers to a quote. */
const FIRST_IMPORT_MS = 6 * 60 * 60 * 1000;

export interface OpenQuote {
  customerId: string | null;
  id: string;
  partId: string | null;
  /** When the quote went out (the reply sent, else approved). */
  since: Date;
}

export interface ErpOrder {
  /** When Takumo first saw it (the order's row was created). */
  createdAt: Date;
  customerId: string | null;
  orderNo: string;
  partId: string;
  qty: number;
}

export interface Settlement {
  lost: string[];
  won: { orderNo: string; qty: number; quoteId: string }[];
}

/**
 * Which open quotes the ERP has answered. Each order wins at most one quote
 * (the most recent one for that part and customer before it). `ordersFeed`:
 * the ERP sends open orders, so a missing order means no order.
 */
export const settleQuotes = (
  quotes: OpenQuote[],
  orders: ErpOrder[],
  now: Date,
  ordersFeed: boolean,
  /** When the first ERP-fed order arrived (the feed's first import). */
  feedStart: Date | null = null
): Settlement => {
  const firstImportEnd = feedStart
    ? feedStart.getTime() + FIRST_IMPORT_MS
    : Number.NEGATIVE_INFINITY;
  const won: Settlement["won"] = [];
  const usedOrders = new Set<string>();
  const byNewest = [...quotes].sort(
    (a, b) => b.since.getTime() - a.since.getTime()
  );
  const wonIds = new Set<string>();
  for (const order of [...orders]
    .filter((o) => o.createdAt.getTime() > firstImportEnd)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const quote = byNewest.find(
      (q) =>
        !wonIds.has(q.id) &&
        q.partId === order.partId &&
        q.customerId !== null &&
        q.customerId === order.customerId &&
        order.createdAt.getTime() >= q.since.getTime() &&
        order.createdAt.getTime() <=
          q.since.getTime() + WIN_WINDOW_DAYS * DAY_MS
    );
    if (quote && !usedOrders.has(order.orderNo)) {
      usedOrders.add(order.orderNo);
      wonIds.add(quote.id);
      won.push({ quoteId: quote.id, orderNo: order.orderNo, qty: order.qty });
    }
  }
  const lost = ordersFeed
    ? quotes
        .filter(
          (q) =>
            !wonIds.has(q.id) &&
            now.getTime() > q.since.getTime() + WIN_WINDOW_DAYS * DAY_MS &&
            // The feed must have watched the whole window to call it lost.
            feedStart !== null &&
            feedStart.getTime() <= q.since.getTime()
        )
        .map((q) => q.id)
    : [];
  return { won, lost };
};
