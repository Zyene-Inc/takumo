import "server-only";

import { database, forOrg } from "@repo/database";
import type { MaterialReady } from "./material";
import { loadMaterial } from "./plan-material";
import { type BuildOptions, buildScheduleRequest } from "./request";

/** A new order (the capacity check's): its material comes after the rest. */
interface ExtraOrder {
  dueDate: string;
  orderNo: string;
  partId: string;
  qty: number;
}

/** Everything the scheduler needs about a shop, as of `startDate`. */
export const loadShop = async (
  orgId: string,
  startDate: string,
  options: BuildOptions & { extra?: ExtraOrder } = {}
) => {
  const db = forOrg(database, orgId);
  const [workCenters, orders, pins, operators] = await Promise.all([
    db.workCenter.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        efficiency: true,
        hourlyRate: true,
        operatorsPerMachine: true,
        unattendedRuns: true,
        shifts: true,
        calendar: {
          where: { date: { gte: new Date(startDate) } },
          select: { date: true, availableHours: true, reason: true },
        },
      },
    }),
    db.order.findMany({
      where: { status: { in: ["open", "in_progress"] } },
      select: {
        orderNo: true,
        partId: true,
        qty: true,
        dueDate: true,
        priority: true,
        price: true,
        status: true,
        jobs: {
          where: {
            OR: [
              { actualEnd: { not: null } },
              { closedAt: { not: null } },
              { qtyDone: { gt: 0 } },
            ],
          },
          select: {
            routingSeq: true,
            actualEnd: true,
            closedAt: true,
            qtyDone: true,
          },
        },
      },
    }),
    db.job.findMany({
      where: { pinned: true, plannedStart: { not: null } },
      select: {
        routingSeq: true,
        workCenterId: true,
        plannedStart: true,
        order: { select: { orderNo: true } },
      },
    }),
    db.operator.findMany({
      where: { active: true },
      select: {
        id: true,
        name: true,
        active: true,
        shifts: true,
        workCenterIds: true,
        canRunUnattended: true,
        days: {
          where: { date: { gte: new Date(startDate) } },
          select: { date: true, hours: true, reason: true },
        },
      },
    }),
  ]);
  const partIds = [
    ...new Set([
      ...orders.map((o) => o.partId),
      ...(options.includeParts ?? []),
    ]),
  ];
  const parts = await db.part.findMany({
    where: { id: { in: partIds } },
    select: {
      id: true,
      partNo: true,
      rev: true,
      material: { select: { unit: true, unitCost: true } },
      routings: {
        select: {
          seq: true,
          workCenterId: true,
          setupMin: true,
          runMinPerUnit: true,
          altWorkCenterIds: true,
        },
      },
    },
  });

  const extra = options.extra
    ? {
        orderNo: options.extra.orderNo,
        partId: options.extra.partId,
        qty: options.extra.qty,
        dueDate: new Date(`${options.extra.dueDate}T00:00:00Z`),
        started: false,
      }
    : null;
  const release: Map<string, MaterialReady> = await loadMaterial(
    orgId,
    partIds,
    orders.map((o) => ({
      orderNo: o.orderNo,
      partId: o.partId,
      qty: o.qty,
      dueDate: o.dueDate,
      // Material is on the floor once an order has started.
      started: o.status === "in_progress" || o.jobs.length > 0,
    })),
    startDate,
    extra
  );
  const built = buildScheduleRequest(
    {
      workCenters,
      parts,
      operators,
      release,
      orders: orders.map(({ jobs, status: _status, ...order }) => ({
        ...order,
        doneSeqs: jobs
          .filter((j) => j.actualEnd || j.closedAt)
          .map((j) => j.routingSeq),
        progress: Object.fromEntries(
          jobs
            .filter((j) => !(j.actualEnd || j.closedAt) && j.qtyDone)
            .map((j) => [j.routingSeq, j.qtyDone as number])
        ),
      })),
      pins: pins.flatMap((p) =>
        p.plannedStart && p.workCenterId
          ? [
              {
                orderNo: p.order.orderNo,
                routingSeq: p.routingSeq,
                workCenterId: p.workCenterId,
                plannedStart: p.plannedStart,
              },
            ]
          : []
      ),
    },
    startDate,
    options
  );
  const unknown = [...release.entries()].filter(
    ([no, r]) => r.unknown && no !== extra?.orderNo
  );
  const notOrdered = [...release.entries()].filter(
    ([no, r]) => r.notOrdered && no !== extra?.orderNo
  );
  if (unknown.length) {
    built.assumptions.push(
      `${unknown.length} order${unknown.length === 1 ? "" : "s"} (e.g. ${unknown[0]?.[0]}): material isn't checked. ${unknown[0]?.[1].note}`
    );
  }
  if (notOrdered.length) {
    built.assumptions.push(
      `${notOrdered.length} order${notOrdered.length === 1 ? "" : "s"} wait for material that isn't ordered yet: ${notOrdered
        .slice(0, 3)
        .map(([no]) => no)
        .join(", ")}${notOrdered.length > 3 ? " and more" : ""}.`
    );
  }
  return {
    ...built,
    /** The new order's material, for the capacity check. */
    extraRelease: extra ? (release.get(extra.orderNo) ?? null) : null,
  };
};
