// Pricing with the shop's own costs (docs/PRODUCT-PLAN.md F2.3, F2.4): the
// material from the drawing's stock size and the latest PO price, outside
// processes from the shop's suppliers, when the material is in the shop, the
// customer's margin floor, and a build-up that says where every number came
// from. Pure: the engine does the arithmetic it always did (machine time,
// margin from past quotes, schedule), this file prepares its inputs and
// explains its answer.

import type {
  QuoteBreak,
  QuoteOperation,
  QuoteResponse,
} from "@repo/engine-client/types";
import { addDays, round } from "./pricing-format";
import type { CostSource } from "./types";

export { buildUp, explainMaterialLine } from "./pricing-build-up";
export { drawingSummary, envelopeText, readDrawing } from "./pricing-drawing";
export type { MaterialPricing, MaterialWait, PoLine } from "./pricing-material";
export {
  latestPoPrice,
  materialPricing,
  materialWait,
} from "./pricing-material";
export {
  doneInHouse,
  outsideDays,
  outsideProcesses,
  supplierFor,
} from "./pricing-outside";
export {
  densityFor,
  normalizeUnit,
  parseStockSize,
  partLengthIn,
  stockUsage,
} from "./pricing-stock";

/** A planned operation as stored on an RFQ line: the engine's fields plus why. */
export interface PlannedOperation extends QuoteOperation {
  /** The similar part the times were scaled from. */
  basis_part_no?: string | null;
  /** Times with nothing behind them (no similar operation). */
  is_default?: boolean;
  reason?: string | null;
}

export const DEFAULT_NOTE = "no similar operation in the shop";

export const operationBasis = (
  op: PlannedOperation,
  ctx: {
    erpSynced: boolean;
    facts: Map<number, { date: string; number: number }>;
    partNo: string;
  }
): { basis: CostSource; isDefault: boolean } => {
  switch (op.source) {
    case "estimator":
      return {
        basis: { kind: "estimator", label: "Entered by the estimator" },
        isDefault: false,
      };
    case "actuals":
      return {
        basis: {
          kind: "actuals",
          label: `Actual job times for ${ctx.partNo}${op.note ? ` (${op.note})` : ""}`,
          ref: ctx.partNo,
        },
        isDefault: false,
      };
    case "comparable": {
      const isDefault =
        op.is_default === true || (op.note ?? "").startsWith(DEFAULT_NOTE);
      if (isDefault) {
        return {
          basis: {
            kind: "default",
            label:
              "Takumo's estimate: no similar operation in the shop. Check it.",
          },
          isDefault: true,
        };
      }
      return {
        basis: {
          kind: "similar_part",
          label: op.basis_part_no
            ? `Like ${op.basis_part_no}`
            : "Like a similar part",
          ...(op.basis_part_no ? { ref: op.basis_part_no } : {}),
        },
        isDefault: false,
      };
    }
    default: {
      const fact = ctx.facts.get(op.seq);
      if (fact) {
        return {
          basis: {
            kind: "fact",
            label: `Approved fact F-${fact.number}`,
            ref: `F-${fact.number}`,
            date: fact.date,
          },
          isDefault: false,
        };
      }
      return {
        basis: ctx.erpSynced
          ? {
              kind: "erp",
              label: `${ctx.partNo} routing from your ERP`,
              ref: ctx.partNo,
            }
          : {
              kind: "routing",
              label: `${ctx.partNo} routing`,
              ref: ctx.partNo,
            },
        isDefault: false,
      };
    }
  }
};

// ---------------------------------------------------------------------------
// Engine calls per material wait (F2.4-R5)

/** Breaks with the same material wait share one engine call. */
export const groupByWait = (
  qtys: number[],
  waits?: Map<number, number | null>
) => {
  const groups = new Map<string, { days: number | null; qtys: number[] }>();
  for (const qty of qtys) {
    const days = waits?.has(qty) ? (waits.get(qty) ?? null) : undefined;
    const key = days === undefined ? "material" : String(days);
    const group = groups.get(key) ?? { days: days ?? null, qtys: [] };
    group.qtys.push(qty);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, g]) => ({
    ...g,
    /** Keep the material's own lead time (no wait worked out). */
    keep: key === "material",
  }));
};

const unique = (items: string[]) => [...new Set(items)];

/** One response from several engine calls (one per material wait). */
export const mergeResponses = (responses: QuoteResponse[]): QuoteResponse => {
  const [first, ...rest] = responses;
  if (rest.length === 0) {
    return first;
  }
  return {
    ...first,
    breaks: responses.flatMap((r) => r.breaks).sort((a, b) => a.qty - b.qty),
    missing: unique(responses.flatMap((r) => r.missing)),
    warnings: unique(responses.flatMap((r) => r.warnings)),
    checks: unique(responses.flatMap((r) => r.checks)),
  };
};

// ---------------------------------------------------------------------------
// After the engine: margin floor, outside lead time, the build-up

/**
 * Raise a break to the customer's margin floor when the suggested margin is
 * below it. Returns the same break when there's nothing to do.
 */
export const applyMarginFloor = (
  row: QuoteBreak,
  floor: number | null
): { row: QuoteBreak; raised: boolean } => {
  if (
    floor === null ||
    row.cost === null ||
    row.margin_pct === null ||
    row.margin_pct >= floor ||
    floor >= 0.9
  ) {
    return { row, raised: false };
  }
  const unit = round(row.cost / (1 - floor) / row.qty, 2);
  const price = round(unit * row.qty, 2);
  return {
    raised: true,
    row: {
      ...row,
      unit_price: unit,
      price,
      margin_pct: price ? round((price - row.cost) / price, 4) : null,
      price_low: Math.max(row.price_low ?? price, price),
      price_high: Math.max(row.price_high ?? price, price),
    },
  };
};

/** Push lead times out by the outside processes' days. */
export const withOutsideDays = (
  row: QuoteBreak,
  days: number,
  requestedDate: string | null
): QuoteBreak => {
  if (days <= 0 || row.lead_time_days === null) {
    return row;
  }
  const completion = row.completion_date
    ? addDays(row.completion_date, days)
    : null;
  return {
    ...row,
    lead_time_days: row.lead_time_days + days,
    completion_date: completion,
    meets_requested:
      requestedDate && completion
        ? completion <= requestedDate
        : row.meets_requested,
  };
};
