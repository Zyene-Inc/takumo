// Stock levels and purchase-order lines.

import "server-only";
import type { ParsedRecord } from "../transform";
import {
  type Context,
  type Counter,
  count,
  listNote,
  lookup,
  num,
  str,
  synced,
} from "./common";

export const saveStock = async (
  ctx: Context,
  records: ParsedRecord[],
  c: Counter
) => {
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

export const savePurchaseOrders = async (
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
      unitPrice: num(v.unitPrice),
      orderedAt: str(v.orderedAt) ? new Date(str(v.orderedAt) as string) : null,
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
