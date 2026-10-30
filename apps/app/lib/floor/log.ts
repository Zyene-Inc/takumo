import "server-only";

import { database, forOrg } from "@repo/database";
import { checkLog, type OperationLog } from "./check";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Record what an operation actually took. Keeps the times the model gave it
 * (for calibration), and moves the order to in progress, or done once every
 * operation is finished.
 */
export const logOperation = async (
  orgId: string,
  userId: string | null,
  log: OperationLog,
  /** The clock to check against (tests run on the demo shop's calendar). */
  now = new Date()
): Promise<Result<{ orderDone: boolean; orderNo: string }>> => {
  const problem = checkLog(log, now);
  if (problem) {
    return { ok: false, error: problem };
  }
  const db = forOrg(database, orgId);
  const order = await db.order.findFirst({
    where: { id: log.orderId },
    select: {
      id: true,
      orderNo: true,
      status: true,
      part: {
        select: {
          routings: {
            select: {
              seq: true,
              setupMin: true,
              runMinPerUnit: true,
              workCenterId: true,
            },
          },
        },
      },
      jobs: {
        select: { routingSeq: true, actualEnd: true, workCenterId: true },
      },
    },
  });
  if (!order) {
    return { ok: false, error: "That order no longer exists." };
  }
  if (order.status === "cancelled") {
    return { ok: false, error: `${order.orderNo} is cancelled.` };
  }
  const op = order.part.routings.find((r) => r.seq === log.seq);
  if (!op) {
    return { ok: false, error: `${order.orderNo} has no op ${log.seq}.` };
  }
  const finishedAt = log.finishedAt ?? now;
  const startedAt =
    log.startedAt ??
    new Date(finishedAt.getTime() - (log.setupMin + log.runMin) * 60_000);
  const planned = order.jobs.find((j) => j.routingSeq === log.seq);
  const actual = {
    actualStart: startedAt,
    actualEnd: finishedAt,
    actualSetupMin: log.setupMin,
    actualRunMin: log.runMin,
    qtyGood: log.qtyGood,
    qtyScrap: log.qtyScrap,
    loggedBy: userId,
    workCenterId: log.workCenterId ?? planned?.workCenterId ?? op.workCenterId,
  };
  const finished = new Set([
    ...order.jobs.filter((j) => j.actualEnd).map((j) => j.routingSeq),
    log.seq,
  ]);
  const orderDone = order.part.routings.every((r) => finished.has(r.seq));
  await database.$transaction(async (tx) => {
    const existing = await tx.job.findFirst({
      where: { orgId, orderId: order.id, routingSeq: log.seq },
      select: { id: true, plannedSetupMin: true, plannedRunMinPerUnit: true },
    });
    // What the model said: from the plan, else the routing as it is now.
    const model = {
      plannedSetupMin: existing?.plannedSetupMin ?? op.setupMin,
      plannedRunMinPerUnit: existing?.plannedRunMinPerUnit ?? op.runMinPerUnit,
    };
    if (existing) {
      await tx.job.update({
        where: { id: existing.id },
        data: { ...actual, ...model, pinned: false },
      });
    } else {
      await tx.job.create({
        data: {
          orgId,
          orderId: order.id,
          routingSeq: log.seq,
          ...actual,
          ...model,
        },
      });
    }
    await tx.order.update({
      where: { id: order.id },
      data: { status: orderDone ? "done" : "in_progress" },
    });
  });
  return { ok: true, orderNo: order.orderNo, orderDone };
};

/** Undo a log: the operation goes back to planned (or unplanned). */
export const clearLog = async (
  orgId: string,
  jobId: string
): Promise<Result<{ orderNo: string }>> => {
  const db = forOrg(database, orgId);
  const job = await db.job.findFirst({
    where: { id: jobId },
    select: { id: true, orderId: true, order: { select: { orderNo: true } } },
  });
  if (!job) {
    return { ok: false, error: "That log no longer exists." };
  }
  await database.$transaction(async (tx) => {
    await tx.job.update({
      where: { id: job.id },
      data: {
        actualStart: null,
        actualEnd: null,
        actualSetupMin: null,
        actualRunMin: null,
        qtyGood: null,
        qtyScrap: null,
        loggedBy: null,
      },
    });
    const left = await tx.job.count({
      where: { orgId, orderId: job.orderId, actualEnd: { not: null } },
    });
    await tx.order.update({
      where: { id: job.orderId },
      data: { status: left ? "in_progress" : "open" },
    });
  });
  return { ok: true, orderNo: job.order.orderNo };
};
