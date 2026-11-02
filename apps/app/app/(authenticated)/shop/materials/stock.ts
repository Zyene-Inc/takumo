// Stock on hand and incoming purchase orders per material (F1.5), from the
// rows the ERP reports feed. Pure, so it can be tested without a database.

export interface StockTotal {
  allocated: number;
  /** Oldest "as of" across locations: the total is only as fresh as that. */
  asOf: Date;
  onHand: number;
}

export interface IncomingLine {
  dueDate: Date;
  poNo: string;
  qty: number;
}

/** Stock summed across locations. */
export const stockByMaterial = (
  rows: {
    asOf: Date;
    materialId: string;
    qtyAllocated: number;
    qtyOnHand: number;
  }[]
) => {
  const totals = new Map<string, StockTotal>();
  for (const r of rows) {
    const t = totals.get(r.materialId);
    if (t) {
      t.onHand += r.qtyOnHand;
      t.allocated += r.qtyAllocated;
      if (r.asOf < t.asOf) {
        t.asOf = r.asOf;
      }
    } else {
      totals.set(r.materialId, {
        onHand: r.qtyOnHand,
        allocated: r.qtyAllocated,
        asOf: r.asOf,
      });
    }
  }
  return totals;
};

/** What a PO line still has to deliver. */
export const remaining = (line: { qtyOrdered: number; qtyReceived: number }) =>
  Math.max(0, line.qtyOrdered - line.qtyReceived);

/** Open PO lines per material, soonest first, skipping fully received ones. */
export const incomingByMaterial = (
  lines: {
    dueDate: Date;
    materialId: string | null;
    poNo: string;
    qtyOrdered: number;
    qtyReceived: number;
  }[]
) => {
  const byMaterial = new Map<string, IncomingLine[]>();
  for (const l of [...lines].sort(
    (a, b) => a.dueDate.getTime() - b.dueDate.getTime()
  )) {
    const left = remaining(l);
    if (!l.materialId || left <= 0) {
      continue;
    }
    const list = byMaterial.get(l.materialId) ?? [];
    list.push({ poNo: l.poNo, qty: left, dueDate: l.dueDate });
    byMaterial.set(l.materialId, list);
  }
  return byMaterial;
};

const startOfTodayUtc = (now: Date) =>
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

/** Due dates are calendar days (stored at UTC midnight). */
export const isLate = (dueDate: Date, now = new Date()) =>
  dueDate.getTime() < startOfTodayUtc(now);

export const day = (d: Date) =>
  d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

export const qty = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 2 });
