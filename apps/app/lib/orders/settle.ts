import "server-only";

import { database, forOrg } from "@repo/database";
import { log } from "@repo/observability/log";
import { enteredPos } from "./entered";
import type { PoLine } from "./types";

// Marks POs entered once the ERP's orders report brings their order back
// (lib/orders/entered.ts). Runs after an orders report imports and daily.

/** One shop. Never throws; returns how many POs it marked. */
export const markEnteredFromErp = async (orgId: string) => {
  try {
    const db = forOrg(database, orgId);
    const waiting = await db.customerPo.findMany({
      where: { status: "review" },
      select: {
        id: true,
        poNo: true,
        customerId: true,
        receivedAt: true,
        lines: true,
      },
    });
    if (waiting.length === 0) {
      return 0;
    }
    const oldest = new Date(
      Math.min(...waiting.map((p) => p.receivedAt.getTime())) - 86_400_000
    );
    const orders = await db.order.findMany({
      where: { syncedAt: { not: null }, createdAt: { gte: oldest } },
      select: {
        customerPo: true,
        customerId: true,
        partId: true,
        qty: true,
        createdAt: true,
        part: { select: { partNo: true } },
      },
    });
    const ids = enteredPos(
      waiting.map((p) => ({
        id: p.id,
        poNo: p.poNo,
        customerId: p.customerId,
        receivedAt: p.receivedAt,
        lines: ((p.lines as PoLine[] | null) ?? []).map((l) => ({
          partId: l.partId,
          partNo: l.partNo,
          qty: l.qty,
        })),
      })),
      orders.map((o) => ({ ...o, partNo: o.part.partNo }))
    );
    if (ids.length === 0) {
      return 0;
    }
    const { count } = await db.customerPo.updateMany({
      where: { id: { in: ids }, status: "review" },
      data: { status: "entered", enteredAt: new Date(), enteredBy: "erp" },
    });
    return count;
  } catch (error) {
    log.warn("Marking POs entered failed", { orgId, error: String(error) });
    return 0;
  }
};

/** Every shop with POs waiting to be entered. */
export const markAllEnteredFromErp = async () => {
  const shops = await database.customerPo.groupBy({
    by: ["orgId"],
    where: { status: "review" },
  });
  let total = 0;
  for (const { orgId } of shops) {
    total += await markEnteredFromErp(orgId);
  }
  return total;
};
