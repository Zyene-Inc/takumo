// Material price from the latest PO, and when the material is in the shop (F2.4-R5).

import { daysBetween, money, round, shortDate } from "./pricing-format";
import { normalizeUnit, stockUsage } from "./pricing-stock";
import type { CostSource, DrawingReading } from "./types";

export interface PoLine {
  dueDate: string;
  lineNo: number;
  orderedAt: string | null;
  poNo: string;
  qtyOrdered: number;
  qtyReceived: number;
  status: string;
  supplier: string | null;
  unit: string | null;
  unitPrice: number | null;
}

export const sameUnit = (a: string | null, b: string | null) =>
  !(a && b) ||
  normalizeUnit(a) === normalizeUnit(b) ||
  a.trim().toLowerCase() === b.trim().toLowerCase();

export interface PoPrice {
  date: string;
  lineNo: number;
  poNo: string;
  supplier: string | null;
  unitPrice: number;
}

/** The newest PO price for the material, in the material's unit. */
export const latestPoPrice = (
  lines: PoLine[],
  materialUnit: string | null
): PoPrice | null => {
  const priced = lines
    .filter(
      (l) =>
        l.unitPrice !== null &&
        l.unitPrice > 0 &&
        l.status !== "cancelled" &&
        sameUnit(l.unit, materialUnit)
    )
    .map((l) => ({ line: l, date: l.orderedAt ?? l.dueDate }))
    .sort((a, b) => b.date.localeCompare(a.date));
  const top = priced[0];
  return top
    ? {
        poNo: top.line.poNo,
        lineNo: top.line.lineNo,
        date: top.date.slice(0, 10),
        supplier: top.line.supplier,
        unitPrice: top.line.unitPrice as number,
      }
    : null;
};

export interface MaterialPricing {
  basis: string;
  /** Before markup. */
  costPerPart: number;
  markup: number;
  /** After markup: what the engine prices with. */
  perPart: number;
  source: CostSource;
  stock: string | null;
  unit: string | null;
  unitPrice: number | null;
  usagePerPart: number | null;
}

export interface MaterialInput {
  drawingUnits: "in" | "mm" | null;
  /** Cost per part typed in by the estimator. */
  estimatorCost: number | null;
  markup: number;
  material: { name: string; unit: string; unitCost: number | null } | null;
  materialText: string | null;
  /** The part's longest dimension in inches (from the drawing's envelope). */
  partLength?: number | null;
  poPrice: PoPrice | null;
  stock: DrawingReading["stock"];
  /** Stock per part typed in by the estimator, in the material's unit. */
  usagePerPart: number | null;
}

export const withMarkup = (
  cost: number,
  markup: number,
  rest: Omit<
    MaterialPricing,
    "costPerPart" | "markup" | "perPart" | "basis"
  > & {
    basis: string;
  }
): MaterialPricing => ({
  ...rest,
  costPerPart: round(cost, 4),
  markup,
  perPart: round(cost * (1 + markup), 4),
  basis:
    markup > 0
      ? `${rest.basis} = ${money(cost)}/part, + ${round(markup * 100, 1)}% material markup`
      : `${rest.basis} = ${money(cost)}/part`,
});

/**
 * Material cost per part, and where it came from: the estimator's number;
 * else stock per part (the estimator's, or from the drawing's stock size) ×
 * the latest PO price (or the material's unit cost); plus the shop's markup.
 * Null when there's not enough to say: the engine then calibrates the cost
 * from past jobs, as before.
 */
export const materialPricing = (
  input: MaterialInput
): MaterialPricing | null => {
  const m = input.material;
  const stockText = input.stock
    ? `${input.stock.size} ${input.stock.form}`
    : null;
  if (input.estimatorCost !== null) {
    return withMarkup(input.estimatorCost, input.markup, {
      basis: `${money(input.estimatorCost)}/part entered by the estimator`,
      source: { kind: "estimator", label: "Entered by the estimator" },
      stock: stockText,
      unit: "ea",
      unitPrice: input.estimatorCost,
      usagePerPart: 1,
    });
  }
  if (!m) {
    return null;
  }
  let usage: { usage: number; basis: string } | null = null;
  if (input.usagePerPart !== null) {
    usage = {
      usage: input.usagePerPart,
      basis: `${input.usagePerPart} ${m.unit} per part (entered)`,
    };
  } else if (input.stock) {
    usage = stockUsage({
      materialName: `${m.name} ${input.materialText ?? ""}`,
      stock: input.stock,
      unit: m.unit,
      units: input.drawingUnits,
      partLength: input.partLength,
    });
  } else if (normalizeUnit(m.unit) === "ea") {
    usage = { usage: 1, basis: `1 ${m.unit} per part` };
  }
  if (!usage) {
    return null;
  }
  const po = input.poPrice;
  if (po) {
    return withMarkup(usage.usage * po.unitPrice, input.markup, {
      basis: `${usage.basis} × ${money(po.unitPrice)}/${m.unit} (PO ${po.poNo}, ${shortDate(po.date)})`,
      source: {
        kind: "po",
        label: `PO ${po.poNo}${po.supplier ? ` from ${po.supplier}` : ""}, ${shortDate(po.date)}`,
        ref: po.poNo,
        date: po.date,
      },
      stock: stockText,
      unit: m.unit,
      unitPrice: po.unitPrice,
      usagePerPart: usage.usage,
    });
  }
  if (m.unitCost !== null) {
    return withMarkup(usage.usage * m.unitCost, input.markup, {
      basis: `${usage.basis} × ${money(m.unitCost)}/${m.unit} (${m.name}'s unit cost)`,
      source: { kind: "material", label: `${m.name} unit cost`, ref: m.name },
      stock: stockText,
      unit: m.unit,
      unitPrice: m.unitCost,
      usagePerPart: usage.usage,
    });
  }
  return null;
};

// ---------------------------------------------------------------------------
// When the material is in the shop (F2.4-R5)

export interface MaterialWait {
  days: number | null;
  source: CostSource;
}

/**
 * Days until there's enough material for `qty` parts: none when free stock
 * covers it, else the open PO that brings enough, else the material's lead
 * time. Without a known stock usage only the lead time can be used.
 */
export const materialWait = (input: {
  /** On hand minus allocated, in the material's unit. */
  available: number;
  leadTimeDays: number | null;
  materialName: string | null;
  openPos: PoLine[];
  qty: number;
  today: string;
  unit: string | null;
  usagePerPart: number | null;
}): MaterialWait => {
  const leadTime = (): MaterialWait =>
    input.leadTimeDays !== null
      ? {
          days: input.leadTimeDays,
          source: {
            kind: "lead_time",
            label: `${input.materialName ?? "Material"} lead time, ${input.leadTimeDays} days`,
          },
        }
      : {
          days: null,
          source: {
            kind: "default",
            label: "No material lead time known: assumed on hand",
          },
        };
  if (!input.materialName) {
    return {
      days: null,
      source: { kind: "default", label: "No material named" },
    };
  }
  if (input.usagePerPart === null) {
    return leadTime();
  }
  const need = input.qty * input.usagePerPart;
  const unit = input.unit ?? "";
  if (input.available >= need) {
    return {
      days: 0,
      source: {
        kind: "stock",
        label: `In stock: ${round(input.available, 2)} ${unit} free, ${round(need, 2)} needed`,
      },
    };
  }
  let covered = Math.max(0, input.available);
  const open = input.openPos
    .filter(
      (p) =>
        (p.status === "open" || p.status === "partial") &&
        sameUnit(p.unit, input.unit)
    )
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  for (const po of open) {
    covered += Math.max(0, po.qtyOrdered - po.qtyReceived);
    if (covered >= need) {
      const days = Math.max(0, daysBetween(input.today, po.dueDate));
      return {
        days,
        source: {
          kind: "po",
          label: `PO ${po.poNo} due ${shortDate(po.dueDate)} brings enough (${round(need, 2)} ${unit} needed)`,
          ref: po.poNo,
          date: po.dueDate.slice(0, 10),
        },
      };
    }
  }
  return leadTime();
};

// ---------------------------------------------------------------------------
// Outside processes (F2.3-R3)
