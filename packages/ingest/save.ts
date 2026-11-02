import "server-only";

import type { PrismaClient } from "@repo/database";
import type { EntityKey } from "./entities";
import type { ParsedRecord, Value } from "./transform";

export interface SaveResult {
  readonly created: number;
  // Things the user should know, e.g. machines we had to create from a routing.
  readonly notes: string[];
  readonly skipped: number;
  readonly updated: number;
}

interface Context {
  readonly db: PrismaClient;
  readonly notes: string[];
  readonly orgId: string;
  // "data" for file imports, "stated" for values a person typed in.
  readonly provenance: "data" | "stated";
  readonly sourceId: string | null;
  // Set when the rows come from the shop's ERP: the records become read-only.
  readonly syncedAt: Date | null;
}

/** The ERP-sync stamp for a record's data, when the rows came from the ERP. */
const synced = (ctx: Context) =>
  ctx.syncedAt ? { syncedAt: ctx.syncedAt } : {};

type Values = Readonly<Record<string, Value>>;

const str = (v: Value | undefined) => (typeof v === "string" ? v : null);
const num = (v: Value | undefined) => (typeof v === "number" ? v : null);
const list = (v: Value | undefined) => (Array.isArray(v) ? v : []);

// Only fields that were mapped and had a value overwrite existing data, so a
// partial re-upload never blanks out what the shop entered before.
const defined = <T extends Record<string, unknown>>(data: T) =>
  Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== null && v !== undefined)
  ) as { [K in keyof T]?: Exclude<T[K], null> };

const BATCH = 25;

// The highest efficiency written as a fraction (the engine allows up to 1.5).
const MAX_EFFICIENCY = 1.5;

const inBatches = async <T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>
) => {
  for (let i = 0; i < items.length; i += BATCH) {
    await Promise.all(items.slice(i, i + BATCH).map(fn));
  }
};

const listNote = (what: string, names: Set<string>) => {
  if (names.size === 0) {
    return null;
  }
  const shown = [...names].slice(0, 5).join(", ");
  const more = names.size > 5 ? ` and ${names.size - 5} more` : "";
  return `${what}: ${shown}${more}`;
};

// Name → id lookups that create missing rows on first use.
const lookup = async (
  ctx: Context,
  kind: "customer" | "material" | "workCenter"
) => {
  const { db, orgId } = ctx;
  const rows =
    kind === "customer"
      ? await db.customer.findMany({
          where: { orgId },
          select: { id: true, name: true },
        })
      : kind === "material"
        ? await db.material.findMany({
            where: { orgId },
            select: { id: true, name: true },
          })
        : await db.workCenter.findMany({
            where: { orgId },
            select: { id: true, name: true },
          });
  const ids = new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
  const created = new Set<string>();

  const get = async (name: string | null) => {
    if (!name) {
      return null;
    }
    const key = name.toLowerCase();
    const existing = ids.get(key);
    if (existing) {
      return existing;
    }
    const where = { orgId_name: { orgId, name } };
    const row =
      kind === "customer"
        ? await db.customer.upsert({
            where,
            create: { orgId, name },
            update: {},
          })
        : kind === "material"
          ? await db.material.upsert({
              where,
              create: { orgId, name, provenance: "assumed" },
              update: {},
            })
          : await db.workCenter.upsert({
              where,
              create: {
                orgId,
                name,
                provenance: "assumed",
                sourceId: ctx.sourceId,
              },
              update: {},
            });
    ids.set(key, row.id);
    created.add(name);
    return row.id;
  };

  return { get, created };
};

// Part numbers referenced by orders, quotes and routings. Without a
// revision it matches any revision (the latest one wins); a new part number
// is created as rev A, or as the revision given.
const partLookup = async (ctx: Context) => {
  const { db, orgId } = ctx;
  const rows = await db.part.findMany({
    where: { orgId },
    select: { id: true, partNo: true, rev: true },
    orderBy: { rev: "asc" },
  });
  const byNo = new Map(rows.map((r) => [r.partNo.toLowerCase(), r.id]));
  const byNoRev = new Map(
    rows.map((r) => [`${r.partNo.toLowerCase()}|${r.rev.toLowerCase()}`, r.id])
  );
  const created = new Set<string>();

  const get = async (partNo: string, rev?: string | null) => {
    const key = partNo.toLowerCase();
    const existing = rev
      ? byNoRev.get(`${key}|${rev.toLowerCase()}`)
      : byNo.get(key);
    if (existing) {
      return existing;
    }
    const newRev = rev ?? "A";
    const row = await db.part.upsert({
      where: { orgId_partNo_rev: { orgId, partNo, rev: newRev } },
      create: { orgId, partNo, rev: newRev },
      update: {},
    });
    byNo.set(key, row.id);
    byNoRev.set(`${key}|${newRev.toLowerCase()}`, row.id);
    created.add(rev ? `${partNo} rev ${rev}` : partNo);
    return row.id;
  };

  return { get, created };
};

interface Counter {
  created: number;
  skipped: number;
  updated: number;
}

const count = (counter: Counter, existed: boolean) => {
  if (existed) {
    counter.updated += 1;
  } else {
    counter.created += 1;
  }
};

const saveWorkCenters = async (
  ctx: Context,
  records: ParsedRecord[],
  c: Counter
) => {
  const { db, orgId } = ctx;
  const shiftsByName = new Map(
    (
      await db.workCenter.findMany({
        where: { orgId },
        select: { name: true, shifts: true },
      })
    ).map((r) => [r.name, (r.shifts as Record<string, unknown> | null) ?? {}])
  );
  await inBatches(records, async ({ values: v }) => {
    const name = str(v.name) as string;
    let efficiency = num(v.efficiency);
    // "90" means 90%; 1.2 is already a fraction (120%, a fast machine).
    if (efficiency !== null && efficiency > MAX_EFFICIENCY) {
      efficiency /= 100;
    }
    const hoursPerDay = num(v.hoursPerDay);
    const data = defined({
      type: str(v.type),
      hourlyRate: num(v.hourlyRate),
      efficiency,
      // Keep the working days already set; only the hours come from the file.
      shifts:
        hoursPerDay === null
          ? null
          : { ...shiftsByName.get(name), hoursPerDay },
    });
    await db.workCenter.upsert({
      where: { orgId_name: { orgId, name } },
      create: {
        orgId,
        name,
        sourceId: ctx.sourceId,
        provenance: ctx.provenance,
        ...data,
        ...synced(ctx),
      },
      update: { ...data, provenance: ctx.provenance, ...synced(ctx) },
    });
    count(c, shiftsByName.has(name));
  });
};

const saveCustomers = async (
  ctx: Context,
  records: ParsedRecord[],
  c: Counter
) => {
  const { db, orgId } = ctx;
  const existing = new Set(
    (
      await db.customer.findMany({ where: { orgId }, select: { name: true } })
    ).map((r) => r.name)
  );
  await inBatches(records, async ({ values: v }) => {
    const name = str(v.name) as string;
    const data = defined({ paymentTermDays: num(v.paymentTermDays) });
    await db.customer.upsert({
      where: { orgId_name: { orgId, name } },
      create: { orgId, name, ...data, ...synced(ctx) },
      update: { ...data, ...synced(ctx) },
    });
    count(c, existing.has(name));
  });
};

const saveMaterials = async (
  ctx: Context,
  records: ParsedRecord[],
  c: Counter
) => {
  const { db, orgId } = ctx;
  const existing = new Set(
    (
      await db.material.findMany({ where: { orgId }, select: { name: true } })
    ).map((r) => r.name)
  );
  await inBatches(records, async ({ values: v }) => {
    const name = str(v.name) as string;
    const data = defined({
      spec: str(v.spec),
      unitCost: num(v.unitCost),
      unit: str(v.unit),
      leadTimeDays: num(v.leadTimeDays),
    });
    await db.material.upsert({
      where: { orgId_name: { orgId, name } },
      create: {
        orgId,
        name,
        provenance: ctx.provenance,
        ...data,
        ...synced(ctx),
      },
      update: { ...data, provenance: ctx.provenance, ...synced(ctx) },
    });
    count(c, existing.has(name));
  });
};

const saveParts = async (ctx: Context, records: ParsedRecord[], c: Counter) => {
  const { db, orgId } = ctx;
  const customers = await lookup(ctx, "customer");
  const materials = await lookup(ctx, "material");
  const existing = new Set(
    (
      await db.part.findMany({
        where: { orgId },
        select: { partNo: true, rev: true },
      })
    ).map((r) => `${r.partNo}|${r.rev}`)
  );
  // References are resolved one at a time so two rows naming the same new
  // customer don't race to create it; the upserts then run in batches.
  const rows: { partNo: string; rev: string; data: Record<string, unknown> }[] =
    [];
  for (const { values: v } of records) {
    rows.push({
      partNo: str(v.partNo) as string,
      rev: str(v.rev) ?? "A",
      data: defined({
        description: str(v.description),
        customerId: await customers.get(str(v.customer)),
        materialId: await materials.get(str(v.material)),
      }),
    });
  }
  await inBatches(rows, async ({ partNo, rev, data }) => {
    await db.part.upsert({
      where: { orgId_partNo_rev: { orgId, partNo, rev } },
      create: { orgId, partNo, rev, ...data, ...synced(ctx) },
      update: { ...data, ...synced(ctx) },
    });
    count(c, existing.has(`${partNo}|${rev}`));
  });
  const notes = [
    listNote("New customers added", customers.created),
    listNote(
      "New materials added (please add specs and costs)",
      materials.created
    ),
  ];
  ctx.notes.push(...notes.filter((n): n is string => n !== null));
};

const saveRoutings = async (
  ctx: Context,
  records: ParsedRecord[],
  c: Counter
) => {
  const { db, orgId } = ctx;
  const parts = await partLookup(ctx);
  const machines = await lookup(ctx, "workCenter");
  const existing = new Set(
    (
      await db.routing.findMany({
        where: { orgId },
        select: { partId: true, seq: true },
      })
    ).map((r) => `${r.partId}|${r.seq}`)
  );
  const rows: {
    partId: string;
    seq: number;
    data: {
      workCenterId: string;
      setupMin: number;
      runMinPerUnit: number;
      altWorkCenterIds?: string[];
      provenance: "data" | "stated";
      confidence: number;
    };
  }[] = [];
  for (const { values: v } of records) {
    const partId = await parts.get(str(v.partNo) as string, str(v.rev));
    const workCenterId = (await machines.get(str(v.workCenter))) as string;
    const altWorkCenterIds: string[] = [];
    const altsGiven = list(v.altWorkCenters).length > 0;
    for (const name of list(v.altWorkCenters)) {
      const id = await machines.get(name);
      if (id && id !== workCenterId) {
        altWorkCenterIds.push(id);
      }
    }
    rows.push({
      partId,
      seq: num(v.seq) as number,
      data: {
        workCenterId,
        setupMin: num(v.setupMin) as number,
        runMinPerUnit: num(v.runMinPerUnit) as number,
        // A file without alternates keeps the ones already set.
        ...(altsGiven ? { altWorkCenterIds } : {}),
        provenance: ctx.provenance,
        confidence: 1,
      },
    });
  }
  await inBatches(rows, async ({ partId, seq, data }) => {
    await db.routing.upsert({
      where: { partId_seq: { partId, seq } },
      create: { orgId, partId, seq, ...data, ...synced(ctx) },
      update: { ...data, ...synced(ctx) },
    });
    count(c, existing.has(`${partId}|${seq}`));
  });
  const notes = [
    listNote(
      "Machines not in your machine list were added with default settings (please review)",
      machines.created
    ),
    listNote("New part numbers added", parts.created),
  ];
  ctx.notes.push(...notes.filter((n): n is string => n !== null));
};

const saveOrders = async (
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
  const notes = [
    listNote(
      "New part numbers added (they have no routing yet)",
      parts.created
    ),
    listNote("New customers added", customers.created),
  ];
  ctx.notes.push(...notes.filter((n): n is string => n !== null));
};

const saveQuotes = async (
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
const saveJobs = async (ctx: Context, records: ParsedRecord[], c: Counter) => {
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

const saveStock = async (ctx: Context, records: ParsedRecord[], c: Counter) => {
  const { db, orgId } = ctx;
  const materials = await lookup(ctx, "material");
  const existing = new Set(
    (
      await db.stockLevel.findMany({
        where: { orgId },
        select: { materialId: true, location: true },
      })
    ).map((r) => `${r.materialId}|${r.location}`)
  );
  for (const { values: v } of records) {
    const materialId = await materials.get(str(v.material));
    if (!materialId) {
      c.skipped += 1;
      continue;
    }
    const location = str(v.location) ?? "";
    const data = {
      qtyOnHand: num(v.qtyOnHand) ?? 0,
      qtyAllocated: num(v.qtyAllocated) ?? 0,
      unit: str(v.unit),
      asOf: ctx.syncedAt ?? new Date(),
      ...synced(ctx),
    };
    await db.stockLevel.upsert({
      where: { orgId_materialId_location: { orgId, materialId, location } },
      create: { orgId, materialId, location, ...data },
      update: data,
    });
    count(c, existing.has(`${materialId}|${location}`));
  }
  const note = listNote("New materials", materials.created);
  if (note) {
    ctx.notes.push(note);
  }
};

const savePurchaseOrders = async (
  ctx: Context,
  records: ParsedRecord[],
  c: Counter
) => {
  const { db, orgId } = ctx;
  const materials = await lookup(ctx, "material");
  const existing = new Set(
    (
      await db.purchaseOrderLine.findMany({
        where: { orgId },
        select: { poNo: true, lineNo: true },
      })
    ).map((r) => `${r.poNo}|${r.lineNo}`)
  );
  for (const { values: v } of records) {
    const poNo = str(v.poNo) as string;
    const lineNo = num(v.lineNo) ?? 1;
    const ordered = num(v.qtyOrdered) ?? 0;
    const received = num(v.qtyReceived) ?? 0;
    let status = "open";
    if (received >= ordered && ordered > 0) {
      status = "received";
    } else if (received > 0) {
      status = "partial";
    }
    const data = {
      materialId: await materials.get(str(v.material)),
      supplier: str(v.supplier),
      qtyOrdered: ordered,
      qtyReceived: received,
      unit: str(v.unit),
      dueDate: new Date(str(v.dueDate) as string),
      status,
      ...synced(ctx),
    };
    await db.purchaseOrderLine.upsert({
      where: { orgId_poNo_lineNo: { orgId, poNo, lineNo } },
      create: { orgId, poNo, lineNo, ...data },
      update: data,
    });
    count(c, existing.has(`${poNo}|${lineNo}`));
  }
  const note = listNote("New materials", materials.created);
  if (note) {
    ctx.notes.push(note);
  }
};

// Operators have no unique name in the database: matched by name here.
const saveOperators = async (
  ctx: Context,
  records: ParsedRecord[],
  c: Counter
) => {
  const { db, orgId } = ctx;
  const byName = new Map(
    (
      await db.operator.findMany({
        where: { orgId },
        select: { id: true, name: true },
      })
    ).map((r) => [r.name.toLowerCase(), r.id])
  );
  for (const { values: v } of records) {
    const name = str(v.name) as string;
    const data = {
      ...defined({ hourlyRate: num(v.hourlyRate) }),
      ...(v.skills === undefined ? {} : { skills: list(v.skills).map(String) }),
      ...synced(ctx),
    };
    const id = byName.get(name.toLowerCase());
    if (id) {
      await db.operator.update({ where: { id }, data });
    } else {
      const row = await db.operator.create({ data: { orgId, name, ...data } });
      byName.set(name.toLowerCase(), row.id);
    }
    count(c, Boolean(id));
  }
};

const SAVERS: Record<
  EntityKey,
  (ctx: Context, records: ParsedRecord[], c: Counter) => Promise<void>
> = {
  workCenters: saveWorkCenters,
  customers: saveCustomers,
  materials: saveMaterials,
  parts: saveParts,
  routings: saveRoutings,
  orders: saveOrders,
  quotes: saveQuotes,
  jobs: saveJobs,
  stock: saveStock,
  purchaseOrders: savePurchaseOrders,
  operators: saveOperators,
};

// Keeps the last row when a file lists the same record twice.
const dedupe = (entity: EntityKey, records: readonly ParsedRecord[]) => {
  const keyOf: Record<EntityKey, (v: Values) => string> = {
    workCenters: (v) => String(v.name).toLowerCase(),
    customers: (v) => String(v.name).toLowerCase(),
    materials: (v) => String(v.name).toLowerCase(),
    parts: (v) => `${v.partNo}|${v.rev ?? "A"}`,
    routings: (v) =>
      `${String(v.partNo).toLowerCase()}|${String(v.rev ?? "").toLowerCase()}|${v.seq}`,
    orders: (v) => String(v.orderNo),
    quotes: (v) => String(v.quoteNo),
    jobs: (v) => `${v.orderNo}|${v.seq}`,
    stock: (v) =>
      `${String(v.material).toLowerCase()}|${String(v.location ?? "").toLowerCase()}`,
    purchaseOrders: (v) => `${v.poNo}|${v.lineNo ?? 1}`,
    operators: (v) => String(v.name).toLowerCase(),
  };
  const byKey = new Map<string, ParsedRecord>();
  for (const record of records) {
    byKey.set(keyOf[entity](record.values), record);
  }
  return {
    unique: [...byKey.values()],
    duplicates: records.length - byKey.size,
  };
};

/**
 * Writes parsed records for one org. Re-importing the same file updates rows
 * in place (matched by name, part number + revision, order number…).
 */
export const saveRecords = async (
  db: PrismaClient,
  orgId: string,
  entity: EntityKey,
  records: readonly ParsedRecord[],
  {
    sourceId = null,
    provenance = "data",
    syncedAt = null,
  }: {
    sourceId?: string | null;
    provenance?: "data" | "stated";
    /** The rows come from the shop's ERP (stamped on each record). */
    syncedAt?: Date | null;
  } = {}
): Promise<SaveResult> => {
  const ctx: Context = { db, orgId, sourceId, provenance, syncedAt, notes: [] };
  const counter: Counter = { created: 0, updated: 0, skipped: 0 };
  const { unique, duplicates } = dedupe(entity, records);
  if (duplicates > 0) {
    ctx.notes.push(
      `${duplicates} duplicate row${duplicates === 1 ? "" : "s"} in the file: the last one was used`
    );
  }
  await SAVERS[entity](ctx, unique, counter);
  return {
    ...counter,
    skipped: counter.skipped + duplicates,
    notes: ctx.notes,
  };
};
