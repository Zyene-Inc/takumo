// The one-screen quote review (docs/PRODUCT-PLAN.md F2.6): where each value
// came from, what to check first, how a highlight sits on a drawing sheet.
// Pure, shared by the browser and tests.

import type {
  Box,
  CostSource,
  DrawingFlag,
  DrawingReading,
  PriceBuildUp,
} from "./types";

/** A highlight box as CSS percentages of the sheet; null when unusable. */
export const boxStyle = (box: Box | null | undefined) => {
  if (!box || box.length !== 4 || box.some((n) => !Number.isFinite(n))) {
    return null;
  }
  const clamp = (n: number) => Math.min(1000, Math.max(0, n));
  const [a, b, c, d] = box.map(clamp) as Box;
  // Some readings come back with corners swapped; order them.
  const top = Math.min(a, c);
  const bottom = Math.max(a, c);
  const left = Math.min(b, d);
  const right = Math.max(b, d);
  if (bottom - top < 1 || right - left < 1) {
    return null;
  }
  const pct = (n: number) => `${n / 10}%`;
  return {
    top: pct(top),
    left: pct(left),
    height: pct(bottom - top),
    width: pct(right - left),
  };
};

const SOURCE_KIND: Record<CostSource["kind"], string> = {
  po: "Purchase order",
  material: "Material price in Shop",
  routing: "The part's routing",
  erp: "Routing from your ERP",
  actuals: "Times from finished jobs",
  fact: "Approved fact",
  similar_part: "A similar part you make",
  default: "Default (nothing behind it yet)",
  estimator: "Entered by the estimator",
  rate: "Machine rate",
  setting: "Settings → Quoting",
  supplier: "Outside supplier",
  history: "Past quotes",
  stock: "Stock on hand",
  lead_time: "Material lead time",
  floor: "Customer's margin floor",
};

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
};

/** A source in plain words: what kind, which record, from when. */
export const describeSource = (source: CostSource) => {
  const parts = [SOURCE_KIND[source.kind] ?? "Source"];
  if (source.label && source.label !== parts[0]) {
    parts.push(source.label);
  }
  if (source.date) {
    parts.push(day(source.date));
  }
  return parts.join(" · ");
};

const q = (ref: string) => encodeURIComponent(ref);
const HREF: Partial<Record<CostSource["kind"], (ref: string) => string>> = {
  po: (ref) => `/shop/materials?q=${q(ref)}`,
  material: (ref) => `/shop/materials?q=${q(ref)}`,
  stock: (ref) => `/shop/materials?q=${q(ref)}`,
  lead_time: (ref) => `/shop/materials?q=${q(ref)}`,
  routing: (ref) => `/shop/parts?q=${q(ref)}`,
  erp: (ref) => `/shop/parts?q=${q(ref)}`,
  actuals: (ref) => `/shop/parts?q=${q(ref)}`,
  similar_part: (ref) => `/shop/parts?q=${q(ref)}`,
  rate: (ref) => `/shop/work-centers?q=${q(ref)}`,
  fact: () => "/knowledge/facts",
  history: (ref) => `/quotes/history?q=${q(ref)}`,
  floor: (ref) => `/shop/customers?q=${q(ref)}`,
};

/** A page that shows the source's record, when there is one. */
export const sourceHref = (source: CostSource) => {
  if (source.kind === "setting" || source.kind === "supplier") {
    return "/settings/quoting";
  }
  if (source.kind === "fact") {
    return "/knowledge/facts";
  }
  return source.ref ? (HREF[source.kind]?.(source.ref) ?? null) : null;
};

/** Order of the top "Check this" list: what changes the price comes first. */
const FLAG_ORDER: DrawingFlag["kind"][] = [
  "no_drawing",
  "conflict",
  "envelope",
  "tolerance",
  "certification",
  "outsourced",
  "new_material",
  "units",
  "scanned",
  "low_confidence",
];

export interface TopIssue {
  flag: DrawingFlag;
  lineId: string;
  lineLabel: string;
}

/**
 * Flags and questions from every line for the top of the screen, most
 * important first, the same message once per line.
 */
export const topIssues = (
  lines: {
    drawing: DrawingReading | null;
    id: string;
    label: string;
  }[],
  extraQuestions: string[] = []
) => {
  const flags: TopIssue[] = [];
  const questions: string[] = [];
  const seenQ = new Set<string>();
  const ask = (text: string) => {
    const key = text.trim().toLowerCase();
    if (key && !seenQ.has(key)) {
      seenQ.add(key);
      questions.push(text.trim());
    }
  };
  for (const line of lines) {
    const seen = new Set<string>();
    for (const flag of line.drawing?.flags ?? []) {
      const key = `${flag.kind}:${flag.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        flags.push({ flag, lineId: line.id, lineLabel: line.label });
      }
    }
    for (const question of line.drawing?.questions ?? []) {
      ask(question);
    }
  }
  for (const question of extraQuestions) {
    ask(question);
  }
  const rank = (k: DrawingFlag["kind"]) => {
    const i = FLAG_ORDER.indexOf(k);
    return i === -1 ? FLAG_ORDER.length : i;
  };
  flags.sort((a, b) => rank(a.flag.kind) - rank(b.flag.kind));
  return { flags, questions };
};

interface BuildUpRow {
  /** Amount per part, or null when unknown. */
  amount: number | null;
  /** True when a default (nothing behind it) is part of this row. */
  isDefault: boolean;
  key: "material" | "operations" | "outside" | "cost" | "margin" | "price";
  label: string;
}

const sum = (values: (number | null)[]) =>
  values.every((v) => v === null)
    ? null
    : values.reduce<number>((t, v) => t + (v ?? 0), 0);

/**
 * One quantity's price per part, in the order an estimator reads it:
 * material + operations + outside = cost; + margin = price.
 */
export const buildUpRows = (b: PriceBuildUp): BuildUpRow[] => {
  const perPart = (total: number | null) =>
    total === null || b.qty <= 0 ? null : total / b.qty;
  const ops = sum(b.operations.map((o) => o.cost));
  const outside = sum(b.outside.map((o) => o.cost));
  const margin =
    b.unitPrice !== null && b.unitCost !== null
      ? b.unitPrice - b.unitCost
      : null;
  return [
    {
      key: "material",
      label: "Material",
      amount: b.material.perPart,
      isDefault: b.material.source.kind === "default",
    },
    {
      key: "operations",
      label: "Machining and labor",
      amount: perPart(ops),
      isDefault: b.operations.some((o) => o.isDefault),
    },
    {
      key: "outside",
      label: "Outside processing",
      amount: perPart(outside),
      isDefault: b.outside.some((o) => o.source.kind === "default"),
    },
    { key: "cost", label: "Cost", amount: b.unitCost, isDefault: false },
    {
      key: "margin",
      label:
        b.margin.pct === null
          ? "Margin"
          : `Margin (${Math.round(b.margin.pct * 100)}%)`,
      amount: margin,
      isDefault: false,
    },
    { key: "price", label: "Price", amount: b.unitPrice, isDefault: false },
  ];
};
