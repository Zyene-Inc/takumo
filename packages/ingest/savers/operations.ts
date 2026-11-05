import "server-only";
import type { ParsedRecord, Value } from "../transform";
import {
  type Context,
  type Counter,
  count,
  inBatches,
  listNote,
  num,
  str,
  synced,
} from "./common";

// The ERP's open-operations report: which steps of each open order are
// closed there and how many parts are through the rest. Orders it doesn't
// know are skipped (they come from the open-orders report).

interface OrderRef {
  id: string;
  partId: string;
  qty: number;
}

interface JobWrite {
  data: Record<string, unknown>;
  orderId: string;
  seq: number;
}

/** The shop's orders, routing steps and existing jobs, keyed for lookups. */
const loadShop = async (ctx: Context) => {
  const { db, orgId } = ctx;
  const [orderRows, routingRows, jobRows] = await Promise.all([
    db.order.findMany({
      where: { orgId },
      select: { id: true, orderNo: true, qty: true, partId: true },
    }),
    db.routing.findMany({
      where: { orgId },
      select: { partId: true, seq: true },
    }),
    db.job.findMany({
      where: { orgId },
      select: { orderId: true, routingSeq: true, closedAt: true },
    }),
  ]);
  const seqsByPart = new Map<string, number[]>();
  for (const r of routingRows) {
    seqsByPart.set(r.partId, [...(seqsByPart.get(r.partId) ?? []), r.seq]);
  }
  return {
    orders: new Map<string, OrderRef>(orderRows.map((o) => [o.orderNo, o])),
    seqsByPart,
    existing: new Map(jobRows.map((j) => [`${j.orderId}|${j.routingSeq}`, j])),
  };
};

/** Parts through a step: as given, or the order's quantity less the parts left. */
const partsThrough = (v: Readonly<Record<string, Value>>, order: OrderRef) => {
  const left = num(v.qtyRemaining);
  return (
    num(v.qtyDone) ?? (left === null ? null : Math.max(0, order.qty - left))
  );
};

// A report of open operations leaves out the finished ones: a routing step
// of a listed order that the report doesn't list is closed in the ERP.
const closeUnlisted = (
  rows: readonly JobWrite[],
  orders: Map<string, OrderRef>,
  seqsByPart: Map<string, number[]>,
  existing: Map<string, { closedAt: Date | null }>,
  now: Date,
  started: Set<string>
) => {
  const listed = new Set(rows.map((r) => `${r.orderId}|${r.seq}`));
  const listedOrders = new Set(rows.map((r) => r.orderId));
  const closed: JobWrite[] = [];
  for (const order of orders.values()) {
    if (!listedOrders.has(order.id)) {
      continue;
    }
    for (const seq of seqsByPart.get(order.partId) ?? []) {
      const key = `${order.id}|${seq}`;
      if (!listed.has(key)) {
        closed.push({
          orderId: order.id,
          seq,
          data: { closedAt: existing.get(key)?.closedAt ?? now },
        });
        started.add(order.id);
      }
    }
  }
  return closed;
};

export const saveOperations = async (
  ctx: Context,
  records: ParsedRecord[],
  c: Counter
) => {
  const { db, orgId } = ctx;
  const { orders, seqsByPart, existing } = await loadShop(ctx);
  const now = ctx.syncedAt ?? new Date();
  const unknown = new Set<string>();
  const started = new Set<string>();
  const rows: JobWrite[] = [];
  for (const { values: v } of records) {
    const orderNo = str(v.orderNo) as string;
    const order = orders.get(orderNo);
    if (!order) {
      unknown.add(orderNo);
      c.skipped += 1;
      continue;
    }
    const seq = num(v.seq) as number;
    const through = partsThrough(v, order);
    const done =
      str(v.status) === "done" || (through !== null && through >= order.qty);
    const prior = existing.get(`${order.id}|${seq}`);
    rows.push({
      orderId: order.id,
      seq,
      data: {
        // Keeps the first time it was seen closed.
        closedAt: done ? (prior?.closedAt ?? now) : null,
        qtyDone: through,
      },
    });
    if (done || str(v.status) === "in_progress" || (through ?? 0) > 0) {
      started.add(order.id);
    }
  }
  const listed = new Set(rows.map((r) => `${r.orderId}|${r.seq}`));
  rows.push(...closeUnlisted(rows, orders, seqsByPart, existing, now, started));
  await inBatches(rows, async ({ orderId, seq, data }) => {
    await db.job.upsert({
      where: { orderId_routingSeq: { orderId, routingSeq: seq } },
      create: { orgId, orderId, routingSeq: seq, ...data, ...synced(ctx) },
      update: { ...data, ...synced(ctx) },
    });
    if (listed.has(`${orderId}|${seq}`)) {
      count(c, existing.has(`${orderId}|${seq}`));
    }
  });
  if (started.size) {
    await db.order.updateMany({
      where: { orgId, id: { in: [...started] }, status: "open" },
      data: { status: "in_progress" },
    });
  }
  const note = listNote(
    "Orders not in your open orders yet (skipped; they'll be picked up after the next open-orders report)",
    unknown
  );
  if (note) {
    ctx.notes.push(note);
  }
};
