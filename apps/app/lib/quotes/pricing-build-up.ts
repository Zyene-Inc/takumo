// The price build-up: where every number in a quote came from.

import type {
  CostLine,
  QuoteBreak,
  QuoteOperation,
  QuoteResponse,
} from "@repo/engine-client/types";
import type { PlannedOperation } from "./pricing";
import { round } from "./pricing-format";
import type { MaterialPricing, MaterialWait } from "./pricing-material";
import type {
  BuildUpOperation,
  BuildUpOutside,
  CostSource,
  PriceBuildUp,
} from "./types";

export const RATE_DEFAULT_LABEL =
  "Shop labor rate (default, set it in Settings → Quoting)";

export interface BuildUpContext {
  floor: number | null;
  floorRaised: Set<number>;
  laborRate: { rate: number; set: boolean };
  machines: Map<string, { efficiency: number; rate: number | null }>;
  material: MaterialPricing | null;
  materialWaits: Map<number, MaterialWait>;
  opBasis: Map<number, { basis: CostSource; isDefault: boolean }>;
  outside: BuildUpOutside[];
  outsideDays: number;
  routing: PlannedOperation[];
  /** The margin the estimator entered on the line, if any. */
  targetMargin?: number | null;
}

export const machineLine = (row: QuoteBreak, op: QuoteOperation) =>
  row.lines.find(
    (l) =>
      l.kind === "machine" && l.label === `Op ${op.seq} · ${op.work_center}`
  );

export const rateSourceFor = (
  workCenter: string,
  machineRate: number | null | undefined,
  laborRate: BuildUpContext["laborRate"]
): CostSource => {
  if (machineRate != null) {
    return {
      kind: "rate",
      label: `${workCenter} hourly rate`,
      ref: workCenter,
    };
  }
  return laborRate.set
    ? { kind: "setting", label: "Shop labor rate (Settings → Quoting)" }
    : { kind: "default", label: RATE_DEFAULT_LABEL };
};

export const operationRow = (
  op: PlannedOperation,
  row: QuoteBreak,
  ctx: BuildUpContext
): BuildUpOperation => {
  const wc = ctx.machines.get(op.work_center);
  const basis = ctx.opBasis.get(op.seq) ?? {
    basis: { kind: "routing" as const, label: "Routing" },
    isDefault: false,
  };
  const minutes =
    (op.setup_min + op.run_min_per_unit * row.qty) / (wc?.efficiency || 1);
  const comparableNote = op.source === "comparable" ? (op.note ?? null) : null;
  return {
    seq: op.seq,
    workCenter: op.work_center,
    alternates: op.alt_work_centers ?? [],
    setupMin: op.setup_min,
    runMinPerUnit: op.run_min_per_unit,
    setupPerPart: round(op.setup_min / row.qty, 2),
    hours: round(minutes / 60, 2),
    rate: wc?.rate ?? ctx.laborRate.rate,
    rateSource: rateSourceFor(op.work_center, wc?.rate, ctx.laborRate),
    cost: machineLine(row, op)?.amount ?? null,
    basis: basis.basis,
    isDefault: basis.isDefault,
    reason: op.reason ?? comparableNote,
  };
};

export const materialRow = (
  row: QuoteBreak,
  m: MaterialPricing | null
): PriceBuildUp["material"] => {
  const line = row.lines.find((l) => l.kind === "material");
  const amount = line?.amount ?? null;
  let source: CostSource;
  if (m) {
    source = m.source;
  } else if (line?.sources.length) {
    source = { kind: "history", label: "Past jobs for this part or material" };
  } else {
    source = { kind: "default", label: "Not known yet" };
  }
  return {
    cost: amount,
    perPart:
      m?.perPart ?? (amount === null ? null : round(amount / row.qty, 4)),
    stock: m?.stock ?? null,
    usagePerPart: m?.usagePerPart ?? null,
    unit: m?.unit ?? null,
    unitPrice: m?.unitPrice ?? null,
    markup: m?.markup ?? null,
    basis: m?.basis ?? line?.basis ?? "No material cost",
    source,
  };
};

export const marginRow = (
  row: QuoteBreak,
  response: QuoteResponse,
  ctx: BuildUpContext
): PriceBuildUp["margin"] => {
  const raised = ctx.floorRaised.has(row.qty);
  return {
    pct: row.margin_pct,
    target: response.margin.target,
    low: response.margin.low,
    high: response.margin.high,
    floor: ctx.floor,
    raisedByFloor: raised,
    source: raised
      ? {
          kind: "floor",
          label: `Raised to the customer's ${round((ctx.floor ?? 0) * 100, 1)}% margin floor`,
        }
      : {
          // An entered target is the estimator's, even with history beside it.
          kind:
            ctx.targetMargin == null && response.margin.sources.length
              ? "history"
              : "estimator",
          label: response.margin.basis,
        },
  };
};

/** Every component of each quantity's price, with its source. */
export const buildUp = (
  response: QuoteResponse,
  ctx: BuildUpContext
): PriceBuildUp[] =>
  response.breaks.map((row) => {
    const outsideLines = row.lines.filter((l) => l.kind === "outside");
    const wait = ctx.materialWaits.get(row.qty);
    return {
      qty: row.qty,
      material: materialRow(row, ctx.material),
      operations: ctx.routing.map((op) => operationRow(op, row, ctx)),
      outside: ctx.outside.map((o) => ({
        ...o,
        cost: outsideLines.find((l) => l.label === o.process)?.amount ?? null,
      })),
      cost: row.cost,
      unitCost: row.unit_cost,
      margin: marginRow(row, response, ctx),
      unitPrice: row.unit_price,
      price: row.price,
      leadTimeDays: row.lead_time_days,
      lead: {
        leadTimeDays:
          row.lead_time_days === null
            ? null
            : row.lead_time_days - ctx.outsideDays,
        materialWaitDays: wait?.days ?? null,
        materialSource: wait?.source ?? {
          kind: "default",
          label: "Not checked",
        },
        outsideDays: ctx.outsideDays,
      },
    };
  });

/** Replace the engine's material line basis with ours (it only saw "per part"). */
export const explainMaterialLine = (
  lines: CostLine[],
  material: MaterialPricing | null
): CostLine[] =>
  material
    ? lines.map((l) =>
        l.kind === "material"
          ? {
              ...l,
              basis: material.basis,
              sources: material.source.ref
                ? [
                    material.source.kind === "po"
                      ? `po ${material.source.ref}`
                      : `material ${material.source.ref}`,
                  ]
                : l.sources,
            }
          : l
      )
    : lines;

// ---------------------------------------------------------------------------
// The drawing, in words, for proposing operations (F2.3-R2)
