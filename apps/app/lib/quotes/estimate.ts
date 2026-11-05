import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import {
  estimateQuote,
  type HistoryPart,
  type OutsideProcess,
  type PastQuote,
  type QuoteBreak,
  type QuoteMaterial,
  type QuoteOperation,
  type QuoteResponse,
} from "@repo/engine-client";
import { recordFailedUsage, recordUsage } from "../ai-usage";
import { CHECK_TIME_LIMIT_S, engineProblem, loadShop } from "../schedule/plan";
import { isoDay } from "../schedule/request";
import {
  applyMarginFloor,
  buildUp,
  drawingSummary,
  envelopeText,
  explainMaterialLine,
  groupByWait,
  latestPoPrice,
  type MaterialPricing,
  type MaterialWait,
  materialPricing,
  materialWait,
  mergeResponses,
  operationBasis,
  outsideDays,
  outsideProcesses,
  type PlannedOperation,
  type PoLine,
  partLengthIn,
  readDrawing,
  withOutsideDays,
} from "./pricing";
import { proposeRouting } from "./propose";
import { type CandidatePart, similarParts, withActuals } from "./routing";
import { quoteSettings } from "./settings";
import type {
  BuildUpOutside,
  DraftInputs,
  DrawingReading,
  LineDraft,
} from "./types";

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
  drawing: unknown;
  finish: string | null;
  id: string;
  notes: string | null;
  part: { id: string } | null;
  partNo: string | null;
  qtys: number[];
  routing: unknown;
  tolerances: string | null;
}

interface RoutingFacts {
  erpSynced: boolean;
  /** Approved facts on the part's operation times, by op number. */
  facts: Map<number, { date: string; number: number }>;
}

/** Approved facts on a part's routing times, and whether the ERP sends it. */
const routingFacts = async (
  orgId: string,
  partId: string
): Promise<RoutingFacts> => {
  const db = forOrg(database, orgId);
  const ops = await db.routing.findMany({
    where: { partId },
    select: { id: true, seq: true, syncedAt: true },
  });
  const facts = ops.length
    ? await db.fact.findMany({
        where: {
          subjectType: "routing",
          subjectId: { in: ops.map((o) => o.id) },
          status: "approved",
          attribute: { in: ["setupMin", "runMinPerUnit"] },
          validTo: null,
        },
        orderBy: { reviewedAt: "desc" },
        select: {
          subjectId: true,
          number: true,
          reviewedAt: true,
          createdAt: true,
        },
      })
    : [];
  const seqOf = new Map(ops.map((o) => [o.id, o.seq]));
  const bySeq = new Map<number, { date: string; number: number }>();
  for (const f of facts) {
    const seq = seqOf.get(f.subjectId);
    if (seq !== undefined && !bySeq.has(seq)) {
      bySeq.set(seq, {
        number: f.number,
        date: isoDay(f.reviewedAt ?? f.createdAt),
      });
    }
  }
  return { erpSynced: ops.some((o) => o.syncedAt), facts: bySeq };
};

const NO_FACTS: RoutingFacts = { erpSynced: false, facts: new Map() };

/**
 * The line's operations: what the estimator saved, else the part's routing
 * (approved facts as they are, other times from finished jobs), else a
 * proposal for a new part from the drawing and similar parts, saved on the
 * line so re-estimating doesn't change it under the estimator.
 */
const operationsFor = async (
  orgId: string,
  line: LineForRouting,
  shop: Awaited<ReturnType<typeof loadQuoteHistory>>,
  context: { customer: string | null; materialName: string | null }
): Promise<
  | {
      ok: true;
      facts: RoutingFacts;
      routing: PlannedOperation[];
      routingNotes: string[];
    }
  | { ok: false; error: string }
> => {
  const saved = line.routing as PlannedOperation[] | null;
  const part = line.part
    ? shop.candidates.find((c) => c.id === line.part?.id)
    : undefined;
  const facts = part ? await routingFacts(orgId, part.id) : NO_FACTS;
  if (saved) {
    const previous = line.draft as LineDraft | null;
    return {
      ok: true,
      facts,
      routing: saved,
      routingNotes: previous?.routingNotes ?? [],
    };
  }
  if (part?.routing.length) {
    const actual = withActuals(part.routing, await actualJobs(orgId, part.id));
    // An approved fact is what the shop says the time is: it stands.
    const routing = actual.map((op) => {
      const original = part.routing.find((r) => r.seq === op.seq);
      return facts.facts.has(op.seq) && original
        ? { ...original, source: "routing" as const }
        : op;
    });
    return { ok: true, facts, routing, routingNotes: [] };
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
        drawing: drawingSummary(readDrawing(line.drawing)),
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
    return {
      ok: true,
      facts,
      routing: proposal.ops,
      routingNotes: proposal.notes,
    };
  } catch (error) {
    await recordFailedUsage(orgId, "routing_proposal", error);
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

const MATERIAL_SELECT = {
  id: true,
  name: true,
  unit: true,
  unitCost: true,
  leadTimeDays: true,
} as const;

/** Open and past PO lines, and free stock, for one material. */
const materialSupply = async (orgId: string, materialId: string) => {
  const db = forOrg(database, orgId);
  const [pos, stock] = await Promise.all([
    db.purchaseOrderLine.findMany({
      where: { materialId },
      orderBy: { dueDate: "desc" },
      take: 200,
      select: {
        poNo: true,
        lineNo: true,
        supplier: true,
        qtyOrdered: true,
        qtyReceived: true,
        unit: true,
        unitPrice: true,
        orderedAt: true,
        dueDate: true,
        status: true,
      },
    }),
    db.stockLevel.findMany({
      where: { materialId },
      select: { qtyOnHand: true, qtyAllocated: true },
    }),
  ]);
  const lines: PoLine[] = pos.map((p) => ({
    ...p,
    orderedAt: p.orderedAt ? isoDay(p.orderedAt) : null,
    dueDate: isoDay(p.dueDate),
  }));
  return {
    lines,
    available: stock.reduce((sum, s) => sum + s.qtyOnHand - s.qtyAllocated, 0),
  };
};

/** The material the engine prices with: our cost per part, or its record. */
const engineMaterial = (
  pricing: MaterialPricing | null,
  material: {
    leadTimeDays: number | null;
    name: string;
    unit: string;
    unitCost: { toString(): string } | null;
  } | null,
  line: {
    materialCost: number | null;
    materialText: string | null;
    usagePerPart: number | null;
  }
): QuoteMaterial | null =>
  pricing
    ? {
        name: material?.name ?? line.materialText ?? "Material",
        unit: "ea",
        unit_cost: pricing.perPart,
        usage_per_part: 1,
        lead_time_days: material?.leadTimeDays ?? null,
      }
    : quoteMaterial(material, line);

interface MaterialRecord {
  id: string;
  leadTimeDays: number | null;
  name: string;
  unit: string;
  unitCost: { toString(): string } | null;
}

/** The material's price per part and, per quantity, when it's in the shop. */
const planMaterial = async (
  orgId: string,
  input: {
    drawing: DrawingReading | null;
    line: {
      materialCost: number | null;
      materialText: string | null;
      qtys: number[];
      usagePerPart: number | null;
    };
    markup: number;
    material: MaterialRecord | null;
    today: string;
  }
) => {
  const { line, material, drawing } = input;
  const supply = material
    ? await materialSupply(orgId, material.id)
    : { lines: [], available: 0 };
  const pricing = materialPricing({
    estimatorCost: line.materialCost,
    usagePerPart: line.usagePerPart,
    stock: drawing?.stock ?? null,
    drawingUnits: drawing?.units ?? null,
    partLength: partLengthIn(
      drawing?.envelope?.value ?? null,
      drawing?.units ?? null
    ),
    markup: input.markup,
    materialText: line.materialText,
    material: material
      ? {
          name: material.name,
          unit: material.unit,
          unitCost: num(material.unitCost),
        }
      : null,
    poPrice: material ? latestPoPrice(supply.lines, material.unit) : null,
  });
  const usage =
    pricing && pricing.unit === material?.unit
      ? pricing.usagePerPart
      : line.usagePerPart;
  const waits = new Map<number, MaterialWait>(
    line.qtys.map((qty) => [
      qty,
      materialWait({
        qty,
        today: input.today,
        materialName: material?.name ?? null,
        unit: material?.unit ?? null,
        usagePerPart: usage,
        available: supply.available,
        openPos: supply.lines,
        leadTimeDays: material?.leadTimeDays ?? null,
      }),
    ])
  );
  return { pricing, waits };
};

/** What the estimator should check: unknown outside lead times, default times. */
const lineWarnings = (
  outside: BuildUpOutside[],
  routing: PlannedOperation[],
  ctx: RoutingFacts & { partNo: string }
) => {
  const warnings: string[] = [];
  const unknownLead = outside.filter(
    (m) => !m.askSupplier && m.leadTimeDays === null
  );
  if (unknownLead.length) {
    warnings.push(
      `No lead time known for ${unknownLead.map((m) => m.process).join(", ")}: ask your supplier, or add it in Settings → Quoting.`
    );
  }
  const defaults = routing.filter((op) => operationBasis(op, ctx).isDefault);
  if (defaults.length) {
    warnings.push(
      `Op ${defaults.map((op) => op.seq).join(", ")}: times are Takumo's estimate with no similar operation behind them. Check them.`
    );
  }
  return warnings;
};

/** The engine's answer with the customer's floor and outside days applied. */
const finishResponse = (
  response: QuoteResponse,
  options: {
    customer: string | null;
    floor: number | null;
    material: MaterialPricing | null;
    outsideDays: number;
    requestedDate: string | null;
  }
) => {
  const raised = new Set<number>();
  const breaks: QuoteBreak[] = response.breaks.map((b) => {
    const floored = applyMarginFloor(b, options.floor);
    if (floored.raised) {
      raised.add(b.qty);
    }
    return withOutsideDays(
      {
        ...floored.row,
        lines: explainMaterialLine(floored.row.lines, options.material),
      },
      options.outsideDays,
      options.requestedDate
    );
  });
  const checks = [...response.checks];
  if (raised.size && options.floor !== null) {
    checks.push(
      `Raised to ${options.customer ?? "the customer"}'s ${Math.round(options.floor * 1000) / 10}% margin floor at ${[...raised].map((q) => q.toLocaleString("en-US")).join(", ")} pcs.`
    );
  }
  return { response: { ...response, breaks, checks }, raised };
};

/**
 * Draft one RFQ line: work out its operations (the part's routing, or a
 * proposal for a new part), price its material, outside processes and
 * margin with the shop's own costs, run the estimate, and save it with a
 * build-up of where every number came from.
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
          customer: { select: { name: true, marginFloor: true } },
        },
      },
      part: {
        select: {
          id: true,
          partNo: true,
          material: { select: MATERIAL_SELECT },
        },
      },
      material: { select: MATERIAL_SELECT },
    },
  });
  if (!line) {
    return { ok: false, error: "That RFQ line no longer exists." };
  }
  if (line.qtys.length === 0) {
    return { ok: false, error: `Line ${line.lineNo} has no quantity.` };
  }
  const [shop, settings] = await Promise.all([
    history ?? loadQuoteHistory(orgId),
    quoteSettings(orgId),
  ]);
  const laborRateSet = await db.shopSettings
    .findFirst({ select: { laborRate: true } })
    .then((r) => r?.laborRate != null);
  const material = line.material ?? line.part?.material ?? null;
  const customer = line.rfq.customer?.name ?? line.rfq.customerName ?? null;
  const partNo = line.part?.partNo ?? line.partNo ?? `Line ${line.lineNo}`;
  const drawing = readDrawing(line.drawing);
  const requestedDate = line.rfq.requestedDate
    ? isoDay(line.rfq.requestedDate)
    : null;

  const operations = await operationsFor(orgId, line, shop, {
    customer,
    materialName: material?.name ?? line.materialText,
  });
  if (!operations.ok) {
    return operations;
  }
  const { routing, routingNotes, facts } = operations;

  const { pricing, waits } = await planMaterial(orgId, {
    line,
    material,
    drawing,
    markup: settings.materialMarkup,
    today,
  });

  const stations = await db.workCenter.findMany({
    select: { name: true, type: true },
  });
  const outside = outsideProcesses({
    saved: line.outside as OutsideProcess[] | null,
    drawingFinishes: drawing?.finishes ?? [],
    lineFinish: line.finish,
    stations: stations.flatMap((w) => [w.name, w.type ?? ""]),
    suppliers: settings.outsideProcesses,
  });
  const extraDays = outsideDays(outside.meta);

  const result = await runEstimate(
    orgId,
    {
      partNo,
      newPart: !line.part,
      customer,
      material: engineMaterial(pricing, material, line),
      routing,
      qtys: line.qtys,
      outside: outside.outside,
      targetMargin: line.targetMargin,
      defaultMargin: settings.defaultMargin,
      requestedDate,
      today,
    },
    shop,
    true,
    {
      laborRate: settings.laborRate,
      materialWaits: material
        ? new Map([...waits].map(([q, w]) => [q, w.days]))
        : undefined,
    }
  );
  if (!result.ok) {
    return result;
  }
  const floor = line.rfq.customer?.marginFloor ?? null;
  const finished = finishResponse(result.response, {
    customer,
    floor,
    material: pricing,
    outsideDays: extraDays,
    requestedDate,
  });
  finished.response.warnings.push(
    ...lineWarnings(outside.meta, routing, { ...facts, partNo })
  );
  const draft: LineDraft = {
    estimatedAt: new Date().toISOString(),
    inputs: result.inputs,
    routingNotes,
    response: finished.response,
    buildUp: buildUp(finished.response, {
      routing,
      material: pricing,
      materialWaits: waits,
      outside: outside.meta,
      outsideDays: extraDays,
      floor,
      floorRaised: finished.raised,
      targetMargin: line.targetMargin,
      laborRate: { rate: settings.laborRate, set: laborRateSet },
      machines: shop.rates,
      opBasis: new Map(
        routing.map((op) => [op.seq, operationBasis(op, { ...facts, partNo })])
      ),
    }),
  };
  // A line that's been quoted keeps the numbers that were sent.
  const saved = await db.rfqLine.updateMany({
    where: { id: line.id, quoteId: null },
    data: {
      draft: draft as object,
      ...(material && !line.materialId ? { materialId: material.id } : {}),
      // New numbers: the estimator's edits to the old ones no longer apply.
      final: Prisma.DbNull,
    },
  });
  if (saved.count === 0) {
    return { ok: false, error: `Line ${line.lineNo} has already been quoted.` };
  }
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
  const [shop, settings] = await Promise.all([
    loadQuoteHistory(orgId),
    quoteSettings(orgId),
  ]);
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
      defaultMargin: settings.defaultMargin,
      requestedDate: options.requestedDate,
      today: options.today,
    },
    shop,
    true,
    { laborRate: settings.laborRate }
  );
};
