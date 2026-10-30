import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import {
  estimateQuote,
  type HistoryPart,
  type OutsideProcess,
  type PastQuote,
  type QuoteMaterial,
  type QuoteOperation,
  type QuoteResponse,
} from "@repo/engine-client";
import { recordUsage } from "../ai-usage";
import { CHECK_TIME_LIMIT_S, engineProblem, loadShop } from "../schedule/plan";
import { isoDay } from "../schedule/request";
import { proposeRouting } from "./propose";
import { type CandidatePart, similarParts, withActuals } from "./routing";
import type { DraftInputs, LineDraft } from "./types";

/** Past quotes sent to the engine (most recent first). */
const HISTORY_LIMIT = 2000;

const num = (value: { toString(): string } | null) =>
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
    db.workCenter.findMany({ select: { id: true, name: true, type: true } }),
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
    machines: workCenters.map((w) => ({ name: w.name, type: w.type })),
  };
};

export interface EstimateInput {
  customer: string | null;
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
  leadTimes = true
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
  let response: QuoteResponse;
  try {
    response = await estimateQuote({
      ...built.request,
      time_limit_s: CHECK_TIME_LIMIT_S,
      lead_times: leadTimes,
      history: history.history,
      history_parts: history.historyParts,
      quote: {
        part_no: input.partNo,
        customer: input.customer,
        material: input.material,
        routing: input.routing,
        qty_breaks: input.qtys,
        outside: input.outside,
        target_margin: input.targetMargin,
        requested_date: input.requestedDate,
      },
    });
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
const actualJobs = async (orgId: string, partId: string) => {
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

/** The material sent to the engine: the shop's record, with the estimator's numbers. */
const quoteMaterial = (
  material: {
    name: string;
    unit: string;
    unitCost: { toString(): string } | null;
    leadTimeDays: number | null;
  } | null,
  line: {
    materialCost: number | null;
    materialText: string | null;
    usagePerPart: number | null;
  }
): QuoteMaterial | null => {
  if (line.materialCost !== null) {
    return {
      name: material?.name ?? line.materialText ?? "Material",
      unit: "ea",
      unit_cost: line.materialCost,
      usage_per_part: 1,
      lead_time_days: material?.leadTimeDays ?? null,
    };
  }
  if (material) {
    return {
      name: material.name,
      unit: material.unit,
      unit_cost: num(material.unitCost),
      lead_time_days: material.leadTimeDays,
      usage_per_part: line.usagePerPart,
    };
  }
  return line.materialText ? { name: line.materialText } : null;
};

interface LineForRouting {
  description: string | null;
  draft: unknown;
  finish: string | null;
  id: string;
  notes: string | null;
  part: { id: string } | null;
  partNo: string | null;
  qtys: number[];
  routing: unknown;
  tolerances: string | null;
}

/**
 * The line's operations: what the estimator saved, else the part's routing
 * (with actual times), else a proposal for a new part, saved on the line so
 * re-estimating doesn't change it under the estimator.
 */
const operationsFor = async (
  orgId: string,
  line: LineForRouting,
  shop: Awaited<ReturnType<typeof loadQuoteHistory>>,
  context: { customer: string | null; materialName: string | null }
): Promise<
  | { ok: true; routing: QuoteOperation[]; routingNotes: string[] }
  | { ok: false; error: string }
> => {
  const saved = line.routing as QuoteOperation[] | null;
  if (saved) {
    const previous = line.draft as LineDraft | null;
    return {
      ok: true,
      routing: saved,
      routingNotes: previous?.routingNotes ?? [],
    };
  }
  const part = line.part
    ? shop.candidates.find((c) => c.id === line.part?.id)
    : undefined;
  if (part?.routing.length) {
    return {
      ok: true,
      routing: withActuals(part.routing, await actualJobs(orgId, part.id)),
      routingNotes: [],
    };
  }
  try {
    const proposal = await proposeRouting({
      candidates: similarParts(
        {
          partNo: line.partNo,
          description: line.description,
          materialName: context.materialName,
        },
        context.customer,
        shop.candidates
      ),
      machines: shop.machines,
      line: {
        partNo: line.partNo,
        description: line.description,
        material: context.materialName,
        qty: line.qtys[0],
        tolerances: line.tolerances,
        finish: line.finish,
        notes: line.notes,
      },
    });
    await recordUsage(
      orgId,
      "routing_proposal",
      proposal.usage.modelId,
      proposal.usage.tokens
    );
    await forOrg(database, orgId).rfqLine.updateMany({
      where: { id: line.id },
      data: { routing: proposal.ops as object[] },
    });
    return { ok: true, routing: proposal.ops, routingNotes: proposal.notes };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Takumo couldn't propose operations for this part.",
    };
  }
};

export type LineEstimate =
  | { ok: true; draft: LineDraft }
  | { ok: false; error: string };

/**
 * Draft one RFQ line: work out its operations (the part's routing, or a
 * proposal for a new part), run the estimate, and save it on the line.
 */
export const estimateLine = async (
  orgId: string,
  lineId: string,
  today: string,
  history?: Awaited<ReturnType<typeof loadQuoteHistory>>
): Promise<LineEstimate> => {
  const db = forOrg(database, orgId);
  const line = await db.rfqLine.findFirst({
    where: { id: lineId },
    include: {
      rfq: {
        select: {
          id: true,
          customerName: true,
          requestedDate: true,
          customer: { select: { name: true } },
        },
      },
      part: {
        select: {
          id: true,
          partNo: true,
          material: {
            select: {
              id: true,
              name: true,
              unit: true,
              unitCost: true,
              leadTimeDays: true,
            },
          },
        },
      },
      material: {
        select: {
          id: true,
          name: true,
          unit: true,
          unitCost: true,
          leadTimeDays: true,
        },
      },
    },
  });
  if (!line) {
    return { ok: false, error: "That RFQ line no longer exists." };
  }
  if (line.qtys.length === 0) {
    return { ok: false, error: `Line ${line.lineNo} has no quantity.` };
  }
  const shop = history ?? (await loadQuoteHistory(orgId));
  const material = line.material ?? line.part?.material ?? null;
  const customer = line.rfq.customer?.name ?? line.rfq.customerName ?? null;
  const partNo = line.part?.partNo ?? line.partNo ?? `Line ${line.lineNo}`;

  const operations = await operationsFor(orgId, line, shop, {
    customer,
    materialName: material?.name ?? line.materialText,
  });
  if (!operations.ok) {
    return operations;
  }
  const { routing, routingNotes } = operations;

  const result = await runEstimate(
    orgId,
    {
      partNo,
      newPart: !line.part,
      customer,
      material: quoteMaterial(material, line),
      routing,
      qtys: line.qtys,
      outside:
        (line.outside as OutsideProcess[] | null) ??
        (line.finish ? [{ description: line.finish }] : []),
      targetMargin: line.targetMargin,
      requestedDate: line.rfq.requestedDate
        ? isoDay(line.rfq.requestedDate)
        : null,
      today,
    },
    shop
  );
  if (!result.ok) {
    return result;
  }
  const draft: LineDraft = {
    estimatedAt: new Date().toISOString(),
    inputs: result.inputs,
    routingNotes,
    response: result.response,
  };
  await db.rfqLine.updateMany({
    where: { id: line.id },
    data: {
      draft: draft as object,
      ...(material && !line.materialId ? { materialId: material.id } : {}),
      // New numbers: the estimator's edits to the old ones no longer apply.
      final: Prisma.DbNull,
    },
  });
  return { ok: true, draft };
};

/**
 * Price a part the shop makes, outside any RFQ (Ask Takumo): its routing with
 * actual times, its material, and the quote history.
 */
export const estimateForPart = async (
  orgId: string,
  partId: string,
  options: {
    customer: string | null;
    qtys: number[];
    requestedDate: string | null;
    targetMargin: number | null;
    today: string;
  }
): Promise<EstimateResult> => {
  const shop = await loadQuoteHistory(orgId);
  const part = shop.candidates.find((c) => c.id === partId);
  if (!part) {
    return { ok: false, error: "That part no longer exists." };
  }
  const record = await forOrg(database, orgId).part.findFirst({
    where: { id: partId },
    select: {
      material: {
        select: { name: true, unit: true, unitCost: true, leadTimeDays: true },
      },
    },
  });
  return runEstimate(
    orgId,
    {
      partNo: part.partNo,
      newPart: false,
      customer: options.customer,
      material: quoteMaterial(record?.material ?? null, {
        materialCost: null,
        materialText: null,
        usagePerPart: null,
      }),
      routing: withActuals(part.routing, await actualJobs(orgId, part.id)),
      qtys: options.qtys,
      outside: [],
      targetMargin: options.targetMargin,
      requestedDate: options.requestedDate,
      today: options.today,
    },
    shop
  );
};
