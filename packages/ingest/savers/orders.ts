// Orders, past quotes and job history.

import "server-only";
import type { ParsedRecord } from "../transform";
import {
  type Context,
  type Counter,
  count,
  defined,
  inBatches,
  listNote,
  lookup,
  num,
  partLookup,
  str,
  synced,
} from "./common";

export const saveOrders = async (
  ctx: Context,
  records: ParsedRecord[],
  c: Counter
) => {
  const { db, orgId } = ctx;
  const parts = await partLookup(ctx);
  const customers = await lookup(ctx, "customer");
  const existing = new Set(
    (
      await db.order.findMany({ where: { orgId }, select: { orderNo: true } })
    ).map((r) => r.orderNo)
  );
  const rows: {
    orderNo: string;
    data: { partId: string; qty: number; dueDate: Date } & Record<
      string,
      unknown
    >;
  }[] = [];
  for (const { values: v } of records) {
    rows.push({
      orderNo: str(v.orderNo) as string,
      data: {
        partId: await parts.get(str(v.partNo) as string, str(v.rev)),
        qty: num(v.qty) as number,
        dueDate: new Date(str(v.dueDate) as string),
        ...defined({
          customerId: await customers.get(str(v.customer)),
          price: num(v.price),
          customerPo: str(v.customerPo),
          priority: num(v.priority),
          status: str(v.status),
        }),
      },
    });
  }
  await inBatches(rows, async ({ orderNo, data }) => {
    await db.order.upsert({
      where: { orgId_orderNo: { orgId, orderNo } },
      create: { orgId, orderNo, ...data, ...synced(ctx) },
      update: { ...data, ...synced(ctx) },
    });
    count(c, existing.has(orderNo));
  });
  // An open-orders report without a status column: every order it lists is
  // open. One closed because an earlier report left it out (closeMissing)
  // reopens when it's listed again.
  const listedWithoutStatus = rows
    .filter((r) => r.data.status === undefined)
    .map((r) => r.orderNo);
  if (ctx.syncedAt && listedWithoutStatus.length) {
    await db.order.updateMany({
      where: { orgId, orderNo: { in: listedWithoutStatus }, status: "done" },
      data: { status: "open" },
    });
  }
  const notes = [
    listNote(
      "New part numbers added (they have no routing yet)",
      parts.created
    ),
    listNote("New customers added", customers.created),
  ];
  ctx.notes.push(...notes.filter((n): n is string => n !== null));
};

export const saveQuotes = async (
  ctx: Context,
  records: ParsedRecord[],
  c: Counter
) => {
  const { db, orgId } = ctx;
  const parts = await partLookup(ctx);
  const customers = await lookup(ctx, "customer");
  const existing = new Set(
    (
      await db.quote.findMany({ where: { orgId }, select: { quoteNo: true } })
    ).map((r) => r.quoteNo)
  );
  const rows: {
    quoteNo: string;
    data: { qty: number } & Record<string, unknown>;
  }[] = [];
  for (const { values: v } of records) {
    const partNo = str(v.partNo);
    const quotedAt = str(v.quotedAt);
    rows.push({
      quoteNo: str(v.quoteNo) as string,
      data: {
        qty: num(v.qty) as number,
        ...defined({
          customerId: await customers.get(str(v.customer)),
          partId: partNo ? await parts.get(partNo, str(v.rev)) : null,
          price: num(v.price),
          leadTimeDays: num(v.leadTimeDays),
          estCost: num(v.estCost),
          actualCost: num(v.actualCost),
          status: str(v.status),
          quotedAt: quotedAt ? new Date(quotedAt) : null,
        }),
      },
    });
  }
  await inBatches(rows, async ({ quoteNo, data }) => {
    await db.quote.upsert({
      where: { orgId_quoteNo: { orgId, quoteNo } },
      create: { orgId, quoteNo, ...data },
      update: data,
    });
    count(c, existing.has(quoteNo));
  });
  const notes = [
    listNote("New part numbers added", parts.created),
    listNote("New customers added", customers.created),
  ];
  ctx.notes.push(...notes.filter((n): n is string => n !== null));
};

// Finished operations from the ERP: matched to orders by number (a closed
// order that isn't in the shop yet is added as done) and to routing
// operations by number.
export const saveJobs = async (
  ctx: Context,
  records: ParsedRecord[],
  c: Counter
) => {
  const { db, orgId } = ctx;
  const parts = await partLookup(ctx);
  const machines = await lookup(ctx, "workCenter");
  const orders = new Map(
    (
      await db.order.findMany({
        where: { orgId },
        select: { id: true, orderNo: true, partId: true },
      })
    ).map((o) => [o.orderNo, o])
  );
  const routings = new Map(
    (
      await db.routing.findMany({
        where: { orgId },
        select: {
          partId: true,
          seq: true,
          setupMin: true,
          runMinPerUnit: true,
        },
      })
    ).map((r) => [`${r.partId}|${r.seq}`, r])
  );
  const existing = new Set(
    (
      await db.job.findMany({
        where: { orgId },
        select: { orderId: true, routingSeq: true },
      })
    ).map((j) => `${j.orderId}|${j.routingSeq}`)
  );
  const addedOrders = new Set<string>();
  const rows: {
    orderId: string;
    seq: number;
    data: Record<string, unknown>;
    created: Record<string, unknown>;
  }[] = [];
  // Orders one at a time (two rows may add the same closed order), then the
  // jobs in batches.
  for (const { values: v } of records) {
    const orderNo = str(v.orderNo) as string;
    const good = num(v.qtyGood) as number;
    const scrapGiven = num(v.qtyScrap);
    const scrap = scrapGiven ?? 0;
    const finishedAt = new Date(str(v.finishedAt) as string);
    const setupMin = num(v.setupMin) as number;
    const runMin = num(v.runMin) as number;
    let order = orders.get(orderNo);
    if (!order) {
      const partId = await parts.get(str(v.partNo) as string, str(v.rev));
      order = await db.order.upsert({
        where: { orgId_orderNo: { orgId, orderNo } },
        create: {
          orgId,
          orderNo,
          partId,
          qty: good + scrap,
          dueDate: finishedAt,
          status: "done",
        },
        update: {},
        select: { id: true, orderNo: true, partId: true },
      });
      orders.set(orderNo, order);
      addedOrders.add(orderNo);
    }
    const seq = num(v.seq) as number;
    const routing = routings.get(`${order.partId}|${seq}`);
    const data = {
      actualStart: new Date(
        finishedAt.getTime() - (setupMin + runMin) * 60_000
      ),
      actualEnd: finishedAt,
      actualSetupMin: setupMin,
      actualRunMin: runMin,
      qtyGood: good,
      ...defined({
        qtyScrap: scrapGiven,
        plannedSetupMin: num(v.plannedSetupMin),
        workCenterId: await machines.get(str(v.workCenter)),
      }),
    };
    rows.push({
      orderId: order.id,
      seq,
      data,
      // A new job's plan is the routing as it is now. A job already in
      // Takumo keeps its plan (recalibration may have changed the routing
      // since) and its scrap, unless the file gives them.
      created: {
        qtyScrap: scrap,
        plannedSetupMin: routing?.setupMin ?? null,
        plannedRunMinPerUnit: routing?.runMinPerUnit ?? null,
      },
    });
  }
  await inBatches(rows, async ({ orderId, seq, data, created }) => {
    await db.job.upsert({
      where: { orderId_routingSeq: { orderId, routingSeq: seq } },
      create: {
        orgId,
        orderId,
        routingSeq: seq,
        ...created,
        ...data,
        ...synced(ctx),
      },
      update: { ...data, ...synced(ctx) },
    });
    count(c, existing.has(`${orderId}|${seq}`));
  });
  const notes = [
    listNote("Closed orders added from the job history", addedOrders),
    listNote("New part numbers added", parts.created),
    listNote(
      "Machines not in your machine list were added (please review)",
      machines.created
    ),
  ];
  ctx.notes.push(...notes.filter((n): n is string => n !== null));
};
