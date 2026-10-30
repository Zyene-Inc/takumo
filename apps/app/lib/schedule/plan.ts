import "server-only";

import { createHash } from "node:crypto";
import { database, forOrg } from "@repo/database";
import {
  type CapacityResponse,
  EngineError,
  type ScheduleRequest,
  type ScheduleResponse,
  SOLVED_STATUSES,
  schedule,
} from "@repo/engine-client";
import { log } from "@repo/observability/log";
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
export interface PlanInput extends Omit<BuiltRequest, "partKeys"> {
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

export interface SavedPlan {
  createdAt: Date;
  createdBy: string | null;
  id: string;
  input: PlanInput;
  output: ScheduleResponse;
}

export interface SavedCheck {
  createdAt: Date;
  id: string;
  input: CheckInput;
  output: CapacityResponse;
  verdict: string | null;
  verdictNote: string | null;
}

export const hashFingerprint = (request: ScheduleRequest) =>
  createHash("sha256").update(planFingerprint(request)).digest("hex");

/** Everything the scheduler needs about a shop, as of `startDate`. */
export const loadShop = async (
  orgId: string,
  startDate: string,
  options: BuildOptions = {}
) => {
  const db = forOrg(database, orgId);
  const [workCenters, orders, pins] = await Promise.all([
    db.workCenter.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        efficiency: true,
        hourlyRate: true,
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

  return buildScheduleRequest(
    {
      workCenters,
      parts,
      orders,
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

export type ReplanResult =
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
