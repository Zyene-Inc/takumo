import "server-only";

import { database, forOrg } from "@repo/database";
import { type MaterialOrder, materialReady } from "./material";

/** Material for the orders (F3.2): stock, open POs, lead times. */
export const loadMaterial = async (
  orgId: string,
  partIds: string[],
  orders: MaterialOrder[],
  startDate: string,
  extra: MaterialOrder | null
) => {
  const db = forOrg(database, orgId);
  const parts = await db.part.findMany({
    where: { id: { in: partIds } },
    select: {
      id: true,
      materialId: true,
      materialQtyPerUnit: true,
      materialUnit: true,
    },
  });
  const materialIds = [
    ...new Set(parts.flatMap((p) => (p.materialId ? [p.materialId] : []))),
  ];
  const [materials, stock, pos] = await Promise.all([
    db.material.findMany({
      where: { id: { in: materialIds } },
      select: { id: true, name: true, unit: true, leadTimeDays: true },
    }),
    db.stockLevel.findMany({
      where: { materialId: { in: materialIds } },
      select: {
        materialId: true,
        qtyOnHand: true,
        qtyAllocated: true,
        unit: true,
      },
    }),
    db.purchaseOrderLine.findMany({
      where: {
        materialId: { in: materialIds },
        status: { in: ["open", "partial"] },
      },
      select: {
        poNo: true,
        materialId: true,
        qtyOrdered: true,
        qtyReceived: true,
        unit: true,
        status: true,
        dueDate: true,
      },
    }),
  ]);
  return materialReady({
    today: startDate,
    orders,
    extra,
    stock,
    pos,
    materials: new Map(
      materials.map((m) => [
        m.id,
        { name: m.name, unit: m.unit, leadTimeDays: m.leadTimeDays },
      ])
    ),
    parts: new Map(
      parts.map((p) => [
        p.id,
        {
          materialId: p.materialId,
          qtyPerUnit: p.materialQtyPerUnit,
          unit: p.materialUnit,
        },
      ])
    ),
  });
};

/** Material-ready for every open order (the Orders page, F3.2-R4). */
export const orderMaterial = async (orgId: string, today: string) => {
  const orders = await forOrg(database, orgId).order.findMany({
    where: { status: { in: ["open", "in_progress"] } },
    select: {
      orderNo: true,
      partId: true,
      qty: true,
      dueDate: true,
      status: true,
      _count: {
        select: {
          jobs: {
            where: {
              OR: [
                { actualEnd: { not: null } },
                { closedAt: { not: null } },
                { qtyDone: { gt: 0 } },
              ],
            },
          },
        },
      },
    },
  });
  return loadMaterial(
    orgId,
    [...new Set(orders.map((o) => o.partId))],
    orders.map((o) => ({
      orderNo: o.orderNo,
      partId: o.partId,
      qty: o.qty,
      dueDate: o.dueDate,
      started: o.status === "in_progress" || o._count.jobs > 0,
    })),
    today,
    null
  );
};
