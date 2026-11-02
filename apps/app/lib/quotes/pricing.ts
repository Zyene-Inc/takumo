// Pricing with the shop's own costs (docs/PRODUCT-PLAN.md F2.3, F2.4): the
// material from the drawing's stock size and the latest PO price, outside
// processes from the shop's suppliers, when the material is in the shop, the
// customer's margin floor, and a build-up that says where every number came
// from. Pure: the engine does the arithmetic it always did (machine time,
// margin from past quotes, schedule), this file prepares its inputs and
// explains its answer.

import type {
  CostLine,
  OutsideProcess,
  QuoteBreak,
  QuoteOperation,
  QuoteResponse,
} from "@repo/engine-client/types";
import type {
  BuildUpOperation,
  BuildUpOutside,
  CostSource,
  DrawingReading,
  OutsideSupplier,
  PriceBuildUp,
} from "./types";

const round = (value: number, places = 2) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

const money = (value: number) =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const shortDate = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

const DAY_MS = 86_400_000;

const daysBetween = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${to.slice(0, 10)}T00:00:00Z`) -
      Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) /
      DAY_MS
  );

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

// ---------------------------------------------------------------------------
// Units and stock

export type StockUnit =
  | "lb"
  | "kg"
  | "in"
  | "ft"
  | "m"
  | "ea"
  | "sqft"
  | "sqin";

const UNIT_WORDS: [StockUnit, RegExp][] = [
  ["lb", /^(lb|lbs|pound|pounds|#)$/],
  ["kg", /^(kg|kgs|kilo|kilos|kilogram|kilograms)$/],
  ["in", /^(in|inch|inches|")$/],
  ["ft", /^(ft|foot|feet|lf|lin ft|')$/],
  ["m", /^(m|meter|meters|metre|metres)$/],
  ["ea", /^(ea|each|pc|pcs|piece|pieces|blank|blanks|unit)$/],
  ["sqft", /^(sqft|sq ft|sq\. ft\.|ft2|ft²|square feet)$/],
  ["sqin", /^(sqin|sq in|sq\. in\.|in2|in²|square inches)$/],
];

/** A unit as the shop wrote it ("LBS", "Feet") → one we can convert, or null. */
export const normalizeUnit = (unit: string | null | undefined) => {
  const u = unit?.trim().toLowerCase();
  if (!u) {
    return null;
  }
  return UNIT_WORDS.find(([, re]) => re.test(u))?.[0] ?? null;
};

/** Pounds per cubic inch, by the words in a material's name or grade. */
const DENSITIES: [RegExp, number, string][] = [
  [/7075/, 0.101, "aluminum 7075"],
  [/2024/, 0.1, "aluminum 2024"],
  [/alum|alu\b|\bal\b|6061|6063|5052|mic-?6|\bal-/, 0.098, "aluminum"],
  [
    /stainless|\bss\b|17-4|15-5|\b30[34]\b|\b316l?\b|\b41[06]\b|\b440c?\b/,
    0.289,
    "stainless steel",
  ],
  [/inconel|\b718\b|\b625\b|hastelloy/, 0.297, "nickel alloy"],
  [/titanium|\bti\b|ti-?6al|6al-?4v/, 0.16, "titanium"],
  [/brass|c360|c260/, 0.307, "brass"],
  [/bronze|c932|c954/, 0.32, "bronze"],
  [/copper|c110|c101/, 0.323, "copper"],
  [/magnesium|az31/, 0.065, "magnesium"],
  [
    /steel|\b10[14][0-9]\b|\b1144\b|12l14|41[34]0|4340|8620|\ba36\b|\ba2\b|\bd2\b|\bo1\b|\bh13\b|\bs7\b/,
    0.284,
    "steel",
  ],
  [/delrin|acetal|\bpom\b/, 0.0513, "acetal"],
  [/peek/, 0.0477, "PEEK"],
  [/uhmw/, 0.0336, "UHMW"],
  [/nylon/, 0.041, "nylon"],
  [/ptfe|teflon/, 0.0784, "PTFE"],
  [/polycarbonate|\bpc\b|lexan/, 0.0434, "polycarbonate"],
  [/\bpvc\b/, 0.0506, "PVC"],
  [/\babs\b/, 0.038, "ABS"],
  [/acrylic|pmma/, 0.043, "acrylic"],
];

export const densityFor = (material: string | null | undefined) => {
  const name = material?.toLowerCase() ?? "";
  const hit = DENSITIES.find(([re]) => re.test(name));
  return hit ? { lbPerIn3: hit[1], family: hit[2] } : null;
};

const MM_PER_IN = 25.4;
const FRACTION = /(\d+)\s*-\s*(\d+)\/(\d+)|(\d+)\/(\d+)|(\d*\.?\d+)/g;

/** Every number in a size, fractions included ("1-1/4" → 1.25). */
const numbers = (text: string) => {
  const out: { at: number; value: number }[] = [];
  for (const m of text.matchAll(FRACTION)) {
    let value: number;
    if (m[1]) {
      value = Number(m[1]) + Number(m[2]) / Number(m[3]);
    } else if (m[4]) {
      value = Number(m[4]) / Number(m[5]);
    } else {
      value = Number(m[6]);
    }
    if (Number.isFinite(value) && value > 0) {
      out.push({ at: m.index ?? 0, value });
    }
  }
  return out;
};

export interface StockDims {
  diameter?: number;
  /** Inside diameter of a tube. */
  inner?: number;
  length?: number;
  thickness?: number;
  width?: number;
}

const DIA_WORD = /(dia|ø|⌀|\bod\b|\brd\b|round)/i;
const WALL_WORD = /wall/i;
const ID_WORD = /\bid\b/i;

/**
 * A stock size as written on a drawing or by an estimator, in inches.
 * "1.25 DIA x 4.0", "Ø32 x 100" (mm), "0.75 x 3 x 6", "2 OD x .125 wall x 6".
 */
const MM_WORD = /\bmm\b/i;
const SIZE_SEPARATOR = /\s*[x×*]\s*/i;

/** "2 OD x .125 wall x 6" or "2 OD x 1.75 ID x 6", in the size's units. */
const tubeSize = (parts: string[]): StockDims | null => {
  const [od, second, length] = parts.map((p) => numbers(p)[0]?.value);
  if (!(od && second && length)) {
    return null;
  }
  const inner =
    ID_WORD.test(parts[1]) && !WALL_WORD.test(parts[1])
      ? second
      : od - 2 * second;
  return inner > 0 && inner < od ? { diameter: od, inner, length } : null;
};

const scaled = (d: StockDims, scale: number): StockDims =>
  Object.fromEntries(
    Object.entries(d).map(([k, v]) => [k, (v as number) * scale])
  ) as StockDims;

/**
 * A stock size as written on a drawing or by an estimator, in inches.
 * "1.25 DIA x 4.0", "Ø32 x 100" (mm), "0.75 x 3 x 6", "2 OD x .125 wall x 6".
 */
export const parseStockSize = (
  size: string,
  form: "bar" | "plate" | "tube" | "sheet" | "other",
  units: "in" | "mm" | null
): StockDims | null => {
  const metric = units === "mm" || MM_WORD.test(size);
  const scale = metric ? 1 / MM_PER_IN : 1;
  const values = numbers(size).map((n) => n.value);
  if (values.length === 0) {
    return null;
  }
  const parts = size.split(SIZE_SEPARATOR);
  if (form === "tube" && parts.length >= 3) {
    const tube = tubeSize(parts);
    return tube ? scaled(tube, scale) : null;
  }
  let dims: StockDims | null = null;
  const round_ = form === "bar" && (DIA_WORD.test(size) || values.length === 2);
  if (round_ && values.length >= 2) {
    dims = { diameter: values[0], length: values[1] };
  } else if (values.length >= 3) {
    const [t, w, l] = [...values].sort((a, b) => a - b);
    dims = { thickness: t, width: w, length: l };
  } else if (values.length === 2 && form === "other") {
    // Square bar given as side x length.
    const [a, b] = [...values].sort((x, y) => x - y);
    dims = { thickness: a, width: a, length: b };
  }
  return dims ? scaled(dims, scale) : null;
};

const volumeIn3 = (d: StockDims) => {
  if (d.diameter && d.length) {
    const inner = d.inner ?? 0;
    return (Math.PI / 4) * (d.diameter ** 2 - inner ** 2) * d.length;
  }
  if (d.thickness && d.width && d.length) {
    return d.thickness * d.width * d.length;
  }
  return null;
};

export interface StockUsage {
  basis: string;
  usage: number;
}

/**
 * How much of the material's unit one part uses, from the stock size: pounds
 * from volume × density, inches or feet of bar, square feet of plate, or one
 * blank. Null when the unit or the material can't be converted.
 */
export const stockUsage = (input: {
  materialName: string | null;
  stock: { form: "bar" | "plate" | "tube" | "sheet" | "other"; size: string };
  unit: string | null;
  units: "in" | "mm" | null;
}): StockUsage | null => {
  const unit = normalizeUnit(input.unit);
  if (!unit) {
    return null;
  }
  const stock = `${input.stock.size} ${input.stock.form}`;
  if (unit === "ea") {
    return { usage: 1, basis: `one ${stock} per part` };
  }
  const dims = parseStockSize(input.stock.size, input.stock.form, input.units);
  if (!dims) {
    return null;
  }
  if (unit === "lb" || unit === "kg") {
    const volume = volumeIn3(dims);
    const density = densityFor(input.materialName);
    if (!(volume && density)) {
      return null;
    }
    const lb = volume * density.lbPerIn3;
    const usage = unit === "kg" ? lb * 0.453_592 : lb;
    return {
      usage: round(usage, 3),
      basis: `${stock}: ${round(volume, 2)} in³ × ${density.lbPerIn3} lb/in³ (${density.family}) = ${round(usage, 3)} ${unit}`,
    };
  }
  if (unit === "in" || unit === "ft" || unit === "m") {
    // Length of stock only makes sense for bar (round or flat) and tube.
    const long = input.stock.form === "bar" || input.stock.form === "tube";
    if (!(dims.length && (dims.diameter || long))) {
      return null;
    }
    const factor = { in: 1, ft: 1 / 12, m: 0.0254 }[unit];
    return {
      usage: round(dims.length * factor, 3),
      basis: `${stock}: ${round(dims.length * factor, 3)} ${unit} of bar per part`,
    };
  }
  // sqft / sqin: plate and sheet.
  if (!(dims.width && dims.length)) {
    return null;
  }
  const sqin = dims.width * dims.length;
  const usage = unit === "sqft" ? sqin / 144 : sqin;
  return {
    usage: round(usage, 3),
    basis: `${stock}: ${round(usage, 3)} ${unit} per part`,
  };
};

// ---------------------------------------------------------------------------
// Material price

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

const sameUnit = (a: string | null, b: string | null) =>
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
  poPrice: PoPrice | null;
  stock: DrawingReading["stock"];
  /** Stock per part typed in by the estimator, in the material's unit. */
  usagePerPart: number | null;
}

const withMarkup = (
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

const PROCESS_WORDS: Record<string, RegExp> = {
  anodize: /anodi[sz]/i,
  plating: /plat|zinc|nickel|chrom|cadmium|tin\b|electroless/i,
  heat_treat:
    /heat ?treat|harden|temper|anneal|stress ?relie|\bht\b|nitrid|carburiz/i,
  passivation: /passivat/i,
  paint: /paint|powder ?coat|e-?coat/i,
};

const kindOf = (text: string) =>
  Object.entries(PROCESS_WORDS).find(([, re]) => re.test(text))?.[0] ?? null;

/** The shop's supplier for a process, matched by name or by kind. */
export const supplierFor = (
  description: string,
  suppliers: OutsideSupplier[]
): OutsideSupplier | null => {
  const text = description.toLowerCase();
  const direct = suppliers.find(
    (s) => s.process.trim() && text.includes(s.process.trim().toLowerCase())
  );
  if (direct) {
    return direct;
  }
  const kind = kindOf(description);
  return kind
    ? (suppliers.find((s) => kindOf(s.process) === kind) ?? null)
    : null;
};

const outsideSource = (
  priced: boolean,
  saved: boolean,
  supplier: OutsideSupplier | null
): CostSource => {
  if (!priced) {
    return { kind: "default", label: "No price yet: ask your supplier" };
  }
  if (saved) {
    return { kind: "estimator", label: "Entered by the estimator" };
  }
  return {
    kind: "supplier",
    label: supplier?.supplier
      ? `${supplier.supplier} (Settings → Quoting)`
      : "Shop's outside-process price (Settings → Quoting)",
  };
};

/** One description per finish on the drawing, else the line's finish text. */
const finishDescriptions = (
  finishes: DrawingReading["finishes"],
  lineFinish: string | null
) => {
  if (finishes.length) {
    return finishes.map((f) =>
      f.spec && !f.value.includes(f.spec) ? `${f.value} per ${f.spec}` : f.value
    );
  }
  return lineFinish ? [lineFinish] : [];
};

export interface OutsidePlan {
  meta: BuildUpOutside[];
  outside: OutsideProcess[];
}

/**
 * Outside operations for a line: the estimator's when saved; else one per
 * finish on the drawing (or the line's finish text), priced from the shop's
 * suppliers. A process with no known price is kept, to ask the supplier.
 */
export const outsideProcesses = (input: {
  drawingFinishes: DrawingReading["finishes"];
  lineFinish: string | null;
  saved: OutsideProcess[] | null;
  suppliers: OutsideSupplier[];
}): OutsidePlan => {
  const describe = (p: OutsideProcess): BuildUpOutside => {
    const s = supplierFor(p.description, input.suppliers);
    const priced = p.cost_per_lot != null || p.cost_per_unit != null;
    return {
      process: p.description,
      supplier: s?.supplier ?? null,
      cost: null,
      leadTimeDays: s?.leadTimeDays ?? null,
      askSupplier: !priced,
      source: outsideSource(priced, Boolean(input.saved), s),
    };
  };
  if (input.saved) {
    return { outside: input.saved, meta: input.saved.map(describe) };
  }
  const descriptions = finishDescriptions(
    input.drawingFinishes,
    input.lineFinish
  );
  const outside = descriptions
    .filter((d) => d.trim())
    .map((description): OutsideProcess => {
      const s = supplierFor(description, input.suppliers);
      return {
        description,
        cost_per_unit: s?.costPerPart ?? null,
        cost_per_lot: s?.lotCharge ?? null,
      };
    });
  return { outside, meta: outside.map(describe) };
};

/** Days outside processes add after machining: they run one after another. */
export const outsideDays = (meta: BuildUpOutside[]) =>
  meta.reduce((sum, m) => sum + (m.leadTimeDays ?? 0), 0);

// ---------------------------------------------------------------------------
// Where an operation's times came from (F2.3-R4)

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

const RATE_DEFAULT_LABEL =
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
}

const machineLine = (row: QuoteBreak, op: QuoteOperation) =>
  row.lines.find(
    (l) =>
      l.kind === "machine" && l.label === `Op ${op.seq} · ${op.work_center}`
  );

const rateSourceFor = (
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

const operationRow = (
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

const materialRow = (
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

const marginRow = (
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
          kind: response.margin.sources.length ? "history" : "estimator",
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

const envelopeLine = (d: DrawingReading) => {
  const e = d.envelope?.value;
  if (!e) {
    return null;
  }
  const size = e.diameter
    ? `Ø${e.diameter} × ${e.length ?? "?"}`
    : [e.l, e.w, e.h].filter((v) => v !== undefined).join(" × ");
  return size ? `Envelope: ${size}${d.units ? ` ${d.units}` : ""}` : null;
};

const featureLine = (f: DrawingReading["features"][number]) =>
  `Feature: ${f.count} × ${f.kind}${f.detail ? ` (${f.detail})` : ""}${f.text ? `: ${f.text}` : ""}`;

/** The tightest few tolerances, tightest first. */
const tightest = (d: DrawingReading, count = 4) =>
  [...d.tolerances]
    .filter((t) => t.tolerance !== null)
    .sort((a, b) => (a.tolerance ?? 0) - (b.tolerance ?? 0))
    .slice(0, count);

export const drawingSummary = (d: DrawingReading | null) => {
  if (!d) {
    return null;
  }
  const lines = [
    d.units ? `Units: ${d.units}` : null,
    envelopeLine(d),
    d.stock ? `Stock: ${d.stock.size} ${d.stock.form}` : null,
    d.material ? `Material: ${d.material.text}` : null,
    ...d.features.map(featureLine),
    ...tightest(d).map((t) => `Tolerance: ${t.text}`),
    ...d.finishes.map(
      (f) => `Finish (outside process, not an operation): ${f.text}`
    ),
  ].filter((l): l is string => Boolean(l));
  return lines.length ? lines.join("\n") : null;
};

/** RfqLine.drawing as stored, or null when it isn't a reading (yet). */
export const readDrawing = (value: unknown): DrawingReading | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const d = value as Partial<DrawingReading>;
  const list = <T>(v: T[] | undefined) => (Array.isArray(v) ? v : []);
  return {
    ...(d as DrawingReading),
    features: list(d.features),
    finishes: list(d.finishes),
    tolerances: list(d.tolerances),
    notes: list(d.notes),
    requirements: list(d.requirements),
    quantities: list(d.quantities),
    flags: list(d.flags),
    questions: list(d.questions),
    titleBlock: d.titleBlock ?? {},
    material: d.material ?? null,
    envelope: d.envelope ?? null,
    stock:
      d.stock && typeof d.stock.size === "string" && d.stock.size.trim()
        ? d.stock
        : null,
    units: d.units ?? null,
  };
};

/** WorkCenter.envelope ({ x, y, z } or { diameter, length }, inches) in words. */
export const envelopeText = (value: unknown) => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const e = value as Record<string, unknown>;
  const n = (k: string) =>
    typeof e[k] === "number" && (e[k] as number) > 0 ? (e[k] as number) : null;
  if (n("diameter")) {
    return `Ø${n("diameter")}${n("length") ? ` × ${n("length")}` : ""} in`;
  }
  const dims = [n("x"), n("y"), n("z")].filter((v): v is number => v !== null);
  return dims.length ? `${dims.join(" × ")} in` : null;
};
