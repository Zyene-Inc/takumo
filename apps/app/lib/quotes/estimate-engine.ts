// Running the engine's estimate: the shop's quote history and the request.

import "server-only";

import { database, forOrg } from "@repo/database";
import {
  estimateQuote,
  type HistoryPart,
  type OutsideProcess,
  type PastQuote,
  type QuoteMaterial,
  type QuoteOperation,
  type QuoteResponse,
} from "@repo/engine-client";
import { CHECK_TIME_LIMIT_S, engineProblem, loadShop } from "../schedule/plan";
import { isoDay } from "../schedule/request";
import { envelopeText, groupByWait, mergeResponses } from "./pricing";
import type { CandidatePart } from "./routing";
import type { DraftInputs } from "./types";

/** Past quotes sent to the engine (most recent first). */
export const HISTORY_LIMIT = 2000;

export const num = (value: { toString(): string } | null) =>
  value === null ? null : Number(value.toString());

/** Every past quote, and the material and routing of every shop part. */
export const loadQuoteHistory = async (orgId: string) => {
  const db = forOrg(database, orgId);
  const [quotes, parts, workCenters] = await Promise.all([
    db.quote.findMany({
      orderBy: { quotedAt: "desc" },
      take: HISTORY_LIMIT,
      select: {
        quoteNo: true,
        qty: true,
        price: true,
        estCost: true,
        actualCost: true,
        status: true,
        quotedAt: true,
        leadTimeDays: true,
        customer: { select: { name: true } },
        part: { select: { partNo: true } },
      },
    }),
    db.part.findMany({
      orderBy: { partNo: "asc" },
      select: {
        id: true,
        partNo: true,
        rev: true,
        description: true,
        material: { select: { name: true } },
        customer: { select: { name: true } },
        routings: {
          orderBy: { seq: "asc" },
          select: {
            seq: true,
            setupMin: true,
            runMinPerUnit: true,
            altWorkCenterIds: true,
            workCenterId: true,
          },
        },
      },
    }),
    db.workCenter.findMany({
      select: {
        id: true,
        name: true,
        type: true,
        hourlyRate: true,
        efficiency: true,
        envelope: true,
        toleranceIn: true,
      },
    }),
  ]);
  const wcName = new Map(workCenters.map((w) => [w.id, w.name]));
  const candidates: CandidatePart[] = parts.map((p) => ({
    id: p.id,
    partNo: p.partNo,
    rev: p.rev,
    description: p.description,
    material: p.material?.name ?? null,
    customer: p.customer?.name ?? null,
    routing: p.routings.flatMap((r) => {
      const name = wcName.get(r.workCenterId);
      return name
        ? [
            {
              seq: r.seq,
              work_center: name,
              setup_min: r.setupMin,
              run_min_per_unit: r.runMinPerUnit,
              alt_work_centers: r.altWorkCenterIds
                .map((id) => wcName.get(id))
                .filter((n): n is string => Boolean(n)),
            },
          ]
        : [];
    }),
  }));
  const history: PastQuote[] = quotes.map((q) => ({
    quote_no: q.quoteNo,
    customer: q.customer?.name ?? null,
    part_no: q.part?.partNo ?? null,
    qty: q.qty,
    price: num(q.price),
    est_cost: num(q.estCost),
    actual_cost: num(q.actualCost),
    status: q.status,
    quoted_at: isoDay(q.quotedAt),
    lead_time_days: q.leadTimeDays,
  }));
  // One history part per part number (the latest revision's routing).
  const byPartNo = new Map<string, HistoryPart>();
  for (const part of candidates) {
    byPartNo.set(part.partNo, {
      part_no: part.partNo,
      material: part.material,
      routing: part.routing,
    });
  }
  return {
    history,
    historyParts: [...byPartNo.values()],
    candidates,
    machines: workCenters.map((w) => ({
      name: w.name,
      type: w.type,
      envelope: envelopeText(w.envelope),
      toleranceIn: w.toleranceIn,
    })),
    rates: new Map(
      workCenters.map((w) => [
        w.name,
        { rate: num(w.hourlyRate), efficiency: w.efficiency || 1 },
      ])
    ),
  };
};

export interface EstimateInput {
  customer: string | null;
  /** The shop's margin while it has no won quotes with known costs. */
  defaultMargin?: number | null;
  material: QuoteMaterial | null;
  newPart: boolean;
  outside: OutsideProcess[];
  partNo: string;
  qtys: number[];
  requestedDate: string | null;
  routing: QuoteOperation[];
  targetMargin: number | null;
  today: string;
}

export type EstimateResult =
  | { ok: true; inputs: DraftInputs; response: QuoteResponse }
  | { ok: false; error: string };

/** Ask the engine for cost, price and lead time at each quantity. */
export const runEstimate = async (
  orgId: string,
  input: EstimateInput,
  history: Awaited<ReturnType<typeof loadQuoteHistory>>,
  leadTimes = true,
  options: {
    /** Rate for machines without an hourly rate of their own. */
    laborRate?: number;
    /** Days until the material is in the shop, per quantity (F2.4-R5). */
    materialWaits?: Map<number, number | null>;
  } = {}
): Promise<EstimateResult> => {
  if (input.routing.length === 0) {
    return {
      ok: false,
      error: `${input.partNo} has no operations yet. Add them to price it.`,
    };
  }
  if (input.qtys.length === 0) {
    return { ok: false, error: "Add at least one quantity." };
  }
  const built = await loadShop(orgId, input.today);
  const workCenters =
    options.laborRate === undefined
      ? built.request.work_centers
      : built.request.work_centers.map((wc) => ({
          ...wc,
          hourly_rate: wc.hourly_rate ?? options.laborRate,
        }));
  let response: QuoteResponse;
  try {
    const responses = await Promise.all(
      groupByWait(input.qtys, options.materialWaits).map((group) =>
        estimateQuote({
          ...built.request,
          work_centers: workCenters,
          time_limit_s: CHECK_TIME_LIMIT_S,
          lead_times: leadTimes,
          history: history.history,
          history_parts: history.historyParts,
          quote: {
            part_no: input.partNo,
            customer: input.customer,
            material:
              input.material && !group.keep
                ? { ...input.material, lead_time_days: group.days }
                : input.material,
            routing: input.routing,
            qty_breaks: group.qtys,
            outside: input.outside,
            target_margin: input.targetMargin,
            default_margin: input.defaultMargin ?? null,
            requested_date: input.requestedDate,
          },
        })
      )
    );
    response = mergeResponses(responses);
  } catch (error) {
    return { ok: false, error: engineProblem(error) };
  }
  return {
    ok: true,
    response,
    inputs: {
      partNo: input.partNo,
      newPart: input.newPart,
      customer: input.customer,
      material: input.material?.name ?? null,
      materialLeadTimeDays: input.material?.lead_time_days ?? null,
      usagePerPart: input.material?.usage_per_part ?? null,
      qtys: input.qtys,
      requestedDate: input.requestedDate,
      routing: input.routing,
      outside: input.outside,
      targetMargin: input.targetMargin,
      today: input.today,
    },
  };
};

/** Finished jobs for a part, per operation, for actual times. */
export const actualJobs = async (orgId: string, partId: string) => {
  const jobs = await forOrg(database, orgId).job.findMany({
    where: {
      actualEnd: { not: null },
      order: { partId },
    },
    orderBy: { actualEnd: "desc" },
    take: 200,
    select: {
      routingSeq: true,
      actualSetupMin: true,
      actualRunMin: true,
      qtyGood: true,
      qtyScrap: true,
      order: { select: { qty: true } },
    },
  });
  return jobs.map((j) => ({
    routingSeq: j.routingSeq,
    actualSetupMin: j.actualSetupMin,
    actualRunMin: j.actualRunMin,
    qty:
      j.qtyGood === null && j.qtyScrap === null
        ? j.order.qty
        : (j.qtyGood ?? 0) + (j.qtyScrap ?? 0),
  }));
};
