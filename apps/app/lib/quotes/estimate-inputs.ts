// What goes into a line's estimate: material, operations from facts and actuals, warnings.

import "server-only";

import { database, forOrg } from "@repo/database";
import type {
  QuoteBreak,
  QuoteMaterial,
  QuoteResponse,
} from "@repo/engine-client";
import { recordFailedUsage, recordUsage } from "../ai-usage";
import { isoDay } from "../schedule/request";
import { actualJobs, type loadQuoteHistory, num } from "./estimate-engine";
import {
  applyMarginFloor,
  drawingSummary,
  explainMaterialLine,
  latestPoPrice,
  type MaterialPricing,
  type MaterialWait,
  materialPricing,
  materialWait,
  operationBasis,
  type PlannedOperation,
  type PoLine,
  partLengthIn,
  readDrawing,
  withOutsideDays,
} from "./pricing";
import { proposeRouting } from "./propose";
import { similarParts, withActuals } from "./routing";
import type { BuildUpOutside, DrawingReading, LineDraft } from "./types";

/** The material sent to the engine: the shop's record, with the estimator's numbers. */
export const quoteMaterial = (
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

export interface LineForRouting {
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

export interface RoutingFacts {
  erpSynced: boolean;
  /** Approved facts on the part's operation times, by op number. */
  facts: Map<number, { date: string; number: number }>;
}

/** Approved facts on a part's routing times, and whether the ERP sends it. */
export const routingFacts = async (
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

export const NO_FACTS: RoutingFacts = { erpSynced: false, facts: new Map() };

/**
 * The line's operations: what the estimator saved, else the part's routing
 * (approved facts as they are, other times from finished jobs), else a
 * proposal for a new part from the drawing and similar parts, saved on the
 * line so re-estimating doesn't change it under the estimator.
 */
export const operationsFor = async (
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

export const MATERIAL_SELECT = {
  id: true,
  name: true,
  unit: true,
  unitCost: true,
  leadTimeDays: true,
} as const;

/** Open and past PO lines, and free stock, for one material. */
export const materialSupply = async (orgId: string, materialId: string) => {
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
export const engineMaterial = (
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

export interface MaterialRecord {
  id: string;
  leadTimeDays: number | null;
  name: string;
  unit: string;
  unitCost: { toString(): string } | null;
}

/** The material's price per part and, per quantity, when it's in the shop. */
export const planMaterial = async (
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
export const lineWarnings = (
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
export const finishResponse = (
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
