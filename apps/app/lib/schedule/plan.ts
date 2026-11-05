import "server-only";

import { createHash } from "node:crypto";
import { database, forOrg } from "@repo/database";
import {
  EngineError,
  type ScheduleRequest,
  type ScheduleResponse,
  SOLVED_STATUSES,
  schedule,
} from "@repo/engine-client";
import { log } from "@repo/observability/log";
import {
  type MaterialOrder,
  type MaterialReady,
  materialReady,
} from "./material";
import {
  type BuildOptions,
  type BuiltRequest,
  buildScheduleRequest,
  planFingerprint,
} from "./request";

export const PLAN = "plan";
export const CAPACITY_CHECK = "capacity_check";

// The board waits for this; capacity checks run more scenarios and get less each.
export const PLAN_TIME_LIMIT_S = 10;
export const CHECK_TIME_LIMIT_S = 6;

/** What a saved plan run stores as `input`. */
interface PlanInput extends Omit<BuiltRequest, "partKeys"> {
  fingerprint: string;
}

/** What a saved capacity check stores as `input`. */
export interface CheckInput {
  addedOrderNo?: string;
  customer: string | null;
  dueDate: string;
  materialCost: number | null;
  orderNo: string;
  partId: string;
  partNo: string;
  price: number | null;
  priority: number;
  qty: number;
  startDate: string;
}

interface SavedPlan {
  createdAt: Date;
  createdBy: string | null;
  id: string;
  input: PlanInput;
  output: ScheduleResponse;
}

export const hashFingerprint = (request: ScheduleRequest) =>
  createHash("sha256").update(planFingerprint(request)).digest("hex");

/** Material for the orders (F3.2): stock, open POs, lead times. */
const loadMaterial = async (
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

/** A message for people when the engine can't be reached or refuses. */
export const engineProblem = (error: unknown) => {
  if (error instanceof EngineError) {
    return error.status === 422
      ? `The scheduler couldn't use this data: ${error.detail}`
      : `The scheduler failed (${error.status}). Try again in a minute.`;
  }
  log.error("Scheduling engine unreachable", { error: String(error) });
  return "The scheduling engine isn't reachable. Check that it's running (pnpm dev:engine locally, ENGINE_URL in production).";
};

export const latestPlan = async (orgId: string): Promise<SavedPlan | null> => {
  const run = await forOrg(database, orgId).scheduleRun.findFirst({
    where: { objective: PLAN, solverStatus: { in: [...SOLVED_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
  return run?.output
    ? {
        id: run.id,
        createdAt: run.createdAt,
        createdBy: run.createdBy,
        input: run.input as unknown as PlanInput,
        output: run.output as unknown as ScheduleResponse,
      }
    : null;
};

/** Local clock time from the engine (no zone) as a Date we store as-is. */
const naive = (value: string) => new Date(`${value}Z`);

type ReplanResult =
  | { ok: true; plan: SavedPlan }
  | { ok: false; error: string; conflicts: string[] };

/**
 * Re-plan the whole shop from today and make it the plan of record: saves a
 * ScheduleRun and rewrites the planned (not yet started) Jobs, keeping pins.
 */
export const replan = async (
  orgId: string,
  userId: string | null,
  startDate: string
): Promise<ReplanResult> => {
  const built = await loadShop(orgId, startDate);
  const request = { ...built.request, time_limit_s: PLAN_TIME_LIMIT_S };

  let output: ScheduleResponse;
  try {
    output = await schedule(request);
  } catch (error) {
    return { ok: false, error: engineProblem(error), conflicts: [] };
  }
  if (!SOLVED_STATUSES.includes(output.status)) {
    return {
      ok: false,
      error:
        output.status === "INFEASIBLE"
          ? "The pinned operations can't all be kept where they are."
          : `The scheduler couldn't build a plan (${output.status}).`,
      conflicts: output.conflicts.map((c) =>
        c.order_no
          ? `${c.order_no}${c.seq ? ` op ${c.seq}` : ""}: ${c.message}`
          : c.message
      ),
    };
  }

  const input: PlanInput = {
    assumptions: built.assumptions,
    skipped: built.skipped,
    request,
    fingerprint: hashFingerprint(built.request),
  };
  const db = forOrg(database, orgId);
  const [orders, workCenters] = await Promise.all([
    db.order.findMany({
      where: { orderNo: { in: request.orders.map((o) => o.order_no) } },
      select: { id: true, orderNo: true },
    }),
    db.workCenter.findMany({ select: { id: true, name: true } }),
  ]);
  const orderId = new Map(orders.map((o) => [o.orderNo, o.id]));
  // The times the model gave each operation, kept on the job for calibration.
  const partOf = new Map(request.orders.map((o) => [o.order_no, o.part_no]));
  const routingOf = new Map(request.parts.map((p) => [p.part_no, p.routing]));
  const plannedTimes = (orderNo: string, seq: number) => {
    const op = routingOf
      .get(partOf.get(orderNo) ?? "")
      ?.find((r) => r.seq === seq);
    return {
      plannedSetupMin: op?.setup_min ?? null,
      plannedRunMinPerUnit: op?.run_min_per_unit ?? null,
    };
  };
  const wcId = new Map(workCenters.map((w) => [w.name, w.id]));

  const run = await database.$transaction(async (tx) => {
    const saved = await tx.scheduleRun.create({
      data: {
        orgId,
        objective: PLAN,
        input: input as object,
        output: output as object,
        solverStatus: output.status,
        createdBy: userId,
      },
    });
    // Jobs that haven't started are the plan; started ones are history.
    await tx.job.deleteMany({ where: { orgId, actualStart: null } });
    await tx.job.createMany({
      skipDuplicates: true,
      data: output.operations.flatMap((op) => {
        const id = orderId.get(op.order_no);
        return id
          ? [
              {
                orgId,
                orderId: id,
                routingSeq: op.seq,
                workCenterId: wcId.get(op.work_center) ?? null,
                plannedStart: naive(op.start_at),
                plannedEnd: naive(op.end_at),
                pinned: op.pinned,
                ...plannedTimes(op.order_no, op.seq),
              },
            ]
          : [];
      }),
    });
    return saved;
  });

  return {
    ok: true,
    plan: {
      id: run.id,
      createdAt: run.createdAt,
      createdBy: run.createdBy,
      input,
      output,
    },
  };
};
