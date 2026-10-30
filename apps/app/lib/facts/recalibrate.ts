import "server-only";

import { database, forOrg } from "@repo/database";
import { factLabel } from "./attributes";
import {
  type CalibratedOp,
  evidenceFor,
  type FinishedJob,
  LOOKBACK_DAYS,
  operationStats,
} from "./calibration";
import { proposeFact } from "./facts";

export const RECALIBRATION = "recalibration";

const DAY_MS = 86_400_000;

/** Every operation with its routing times and when each last changed. */
const loadOps = async (orgId: string): Promise<CalibratedOp[]> => {
  const db = forOrg(database, orgId);
  const [routings, changes] = await Promise.all([
    db.routing.findMany({
      select: {
        id: true,
        seq: true,
        setupMin: true,
        runMinPerUnit: true,
        part: { select: { partNo: true, rev: true } },
        workCenter: { select: { name: true } },
      },
    }),
    db.fact.findMany({
      where: {
        subjectType: "routing",
        status: { in: ["approved", "superseded"] },
        attribute: { in: ["setupMin", "runMinPerUnit"] },
        reviewedAt: { not: null },
      },
      select: { subjectId: true, attribute: true, reviewedAt: true },
    }),
  ]);
  const lastChange = (id: string, attribute: string) => {
    const times = changes
      .filter(
        (c) => c.subjectId === id && c.attribute === attribute && c.reviewedAt
      )
      .map((c) => c.reviewedAt?.getTime() ?? 0);
    return times.length ? new Date(Math.max(...times)) : null;
  };
  return routings.map((r) => ({
    id: r.id,
    label: `${r.part.partNo} rev ${r.part.rev} op ${r.seq} (${r.workCenter.name})`,
    setupMin: r.setupMin,
    runMinPerUnit: r.runMinPerUnit,
    setupSince: lastChange(r.id, "setupMin"),
    runSince: lastChange(r.id, "runMinPerUnit"),
  }));
};

/** Finished operations, matched to the routing they ran from. */
export const loadFinishedJobs = async (
  orgId: string,
  since: Date
): Promise<FinishedJob[]> => {
  const db = forOrg(database, orgId);
  const [jobs, routings] = await Promise.all([
    db.job.findMany({
      where: { actualEnd: { gte: since } },
      orderBy: { actualEnd: "asc" },
      take: 20_000,
      select: {
        routingSeq: true,
        actualEnd: true,
        actualSetupMin: true,
        actualRunMin: true,
        qtyGood: true,
        qtyScrap: true,
        plannedSetupMin: true,
        plannedRunMinPerUnit: true,
        order: { select: { orderNo: true, partId: true, qty: true } },
      },
    }),
    db.routing.findMany({ select: { id: true, partId: true, seq: true } }),
  ]);
  const routingId = new Map(
    routings.map((r) => [`${r.partId}|${r.seq}`, r.id])
  );
  return jobs.map((j) => ({
    orderNo: j.order.orderNo,
    routingId: routingId.get(`${j.order.partId}|${j.routingSeq}`) ?? null,
    actualEnd: j.actualEnd as Date,
    actualSetupMin: j.actualSetupMin,
    actualRunMin: j.actualRunMin,
    plannedSetupMin: j.plannedSetupMin,
    plannedRunMinPerUnit: j.plannedRunMinPerUnit,
    qty:
      j.qtyGood === null && j.qtyScrap === null
        ? j.order.qty
        : (j.qtyGood ?? 0) + (j.qtyScrap ?? 0),
  }));
};

/** Actual vs routing for every operation with recent jobs (the calibration page). */
export const calibrationStats = async (orgId: string, now = new Date()) => {
  const [ops, jobs] = await Promise.all([
    loadOps(orgId),
    loadFinishedJobs(orgId, new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS)),
  ]);
  return operationStats(ops, jobs, now);
};

export interface RecalibrationResult {
  operations: number;
  /** Facts proposed (new) or refreshed with newer jobs. */
  proposed: string[];
  refreshed: string[];
}

/**
 * Compare planned and actual times per operation and propose a fact for
 * each one that's off. Takumo's own pending proposal for the same thing is
 * refreshed with the newer numbers instead of duplicated. Runs nightly and
 * on demand; logged as a "recalibration" run.
 */
export const recalibrate = async (
  orgId: string,
  now = new Date(),
  userId: string | null = null
): Promise<RecalibrationResult> => {
  const db = forOrg(database, orgId);
  const stats = await calibrationStats(orgId, now);
  const result: RecalibrationResult = {
    proposed: [],
    refreshed: [],
    operations: new Set(stats.map((s) => s.op.id)).size,
  };
  for (const s of stats.filter((x) => x.propose)) {
    const evidence = evidenceFor(s);
    const mine = await db.fact.findFirst({
      where: {
        status: "pending",
        source: RECALIBRATION,
        subjectType: "routing",
        subjectId: s.op.id,
        attribute: s.attribute,
      },
      select: { id: true, number: true, value: true },
    });
    if (mine) {
      if (mine.value !== s.value) {
        await db.fact.updateMany({
          where: { id: mine.id },
          data: { value: s.value, evidence, previousValue: s.current },
        });
        result.refreshed.push(factLabel(mine.number));
      }
      continue;
    }
    const made = await proposeFact(orgId, {
      subject: { type: "routing", id: s.op.id, label: s.op.label },
      attribute: s.attribute,
      value: s.value,
      evidence,
      source: RECALIBRATION,
      statedBy: null,
    });
    if (made.ok && !made.existing) {
      result.proposed.push(made.fact.label);
    }
  }
  await database.scheduleRun.create({
    data: {
      orgId,
      objective: RECALIBRATION,
      input: { at: now.toISOString() },
      output: result as object,
      solverStatus: "DONE",
      createdBy: userId,
    },
  });
  return result;
};
