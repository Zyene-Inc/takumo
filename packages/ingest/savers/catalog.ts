// Parts and routings.

import "server-only";
import type { ParsedRecord } from "../transform";
import {
  type Context,
  type Counter,
  count,
  defined,
  inBatches,
  list,
  listNote,
  lookup,
  num,
  partLookup,
  str,
  synced,
} from "./common";

export const saveParts = async (
  ctx: Context,
  records: ParsedRecord[],
  c: Counter
) => {
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
        // How much stock one part uses (the ERP's bill of materials), for
        // material-ready dates (F3.2).
        materialQtyPerUnit: num(v.materialQtyPerUnit),
        materialUnit: str(v.materialUnit),
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

export const saveRoutings = async (
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
