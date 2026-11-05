// Stock sizes and units: how much material one part uses (F2.4).

import { round } from "./pricing-format";

export type StockUnit =
  | "lb"
  | "kg"
  | "in"
  | "ft"
  | "m"
  | "ea"
  | "sqft"
  | "sqin";

export const UNIT_WORDS: [StockUnit, RegExp][] = [
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
export const DENSITIES: [RegExp, number, string][] = [
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

export const MM_PER_IN = 25.4;

export const FRACTION = /(\d+)\s*-\s*(\d+)\/(\d+)|(\d+)\/(\d+)|(\d*\.?\d+)/g;

/** Every number in a size, fractions included ("1-1/4" → 1.25). */
export const numbers = (text: string) => {
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

export const DIA_WORD = /(dia|ø|⌀|\bod\b|\brd\b|round)/i;

export const WALL_WORD = /wall/i;

export const ID_WORD = /\bid\b/i;

/**
 * A stock size as written on a drawing or by an estimator, in inches.
 * "1.25 DIA x 4.0", "Ø32 x 100" (mm), "0.75 x 3 x 6", "2 OD x .125 wall x 6".
 */
export const MM_WORD = /\bmm\b/i;

/** An inch mark: the size is in inches whatever the drawing's units. */
export const INCH_WORD = /("|''|\d\s*in\b|\binch(es)?\b)/i;

/** Saw kerf and facing added when the length comes from the part's size. */
export const CUT_ALLOWANCE_IN = 0.125;

export const SIZE_SEPARATOR = /\s*[x×*]\s*/i;

/** Round bar: "2 dia x 5", or "2.0 dia bar" with no length (stockUsage
 * takes it from the part). */
export const roundDims = (values: number[]): StockDims =>
  values.length >= 2
    ? { diameter: values[0], length: values[1] }
    : { diameter: values[0] };

/** Plate, sheet, flat or square bar: thickness, width and length. */
export const flatDims = (
  values: number[],
  form: "bar" | "plate" | "tube" | "sheet" | "other"
): StockDims | null => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length >= 3) {
    return { thickness: sorted[0], width: sorted[1], length: sorted[2] };
  }
  if (sorted.length === 1 && form === "bar") {
    return { diameter: sorted[0] };
  }
  if (sorted.length !== 2) {
    return null;
  }
  if (form === "other") {
    // Square bar given as side x length.
    return { thickness: sorted[0], width: sorted[0], length: sorted[1] };
  }
  // "1 x 4 plate": thickness x width; stockUsage takes the length from the
  // part.
  return form === "plate" || form === "sheet"
    ? { thickness: sorted[0], width: sorted[1] }
    : null;
};

/** "2 OD x .125 wall x 6" or "2 OD x 1.75 ID x 6", in the size's units. */
export const tubeSize = (parts: string[]): StockDims | null => {
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

export const scaled = (d: StockDims, scale: number): StockDims =>
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
  // A unit written in the size wins over the drawing's: a metric drawing's
  // stock is often bought (and suggested) in inches, and dividing an inch
  // size by 25.4 made the material nearly free.
  const metric =
    MM_WORD.test(size) || (units === "mm" && !INCH_WORD.test(size));
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
  const round_ = form === "bar" && (DIA_WORD.test(size) || values.length === 2);
  const dims = round_ ? roundDims(values) : flatDims(values, form);
  return dims ? scaled(dims, scale) : null;
};

export const volumeIn3 = (d: StockDims) => {
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
 * The stock's dimensions in inches, with the length taken from the part
 * (plus a cut) when the size leaves it out, and how to name it.
 */
export const sizedStock = (
  input: {
    partLength?: number | null;
    stock: { form: "bar" | "plate" | "tube" | "sheet" | "other"; size: string };
    units: "in" | "mm" | null;
  },
  stockName: string
) => {
  const parsed = parseStockSize(
    input.stock.size,
    input.stock.form,
    input.units
  );
  if (!parsed) {
    return null;
  }
  if (parsed.length || !input.partLength) {
    return { dims: parsed, stock: stockName };
  }
  const length = input.partLength + CUT_ALLOWANCE_IN;
  return {
    dims: { ...parsed, length },
    stock: `${stockName}, ${round(length, 3)} in long (the part plus ${CUT_ALLOWANCE_IN} in to cut and face)`,
  };
};

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
  /** The part's longest dimension in inches, for a stock size with no length. */
  partLength?: number | null;
}): StockUsage | null => {
  const unit = normalizeUnit(input.unit);
  if (!unit) {
    return null;
  }
  const stockName = `${input.stock.size} ${input.stock.form}`;
  if (unit === "ea") {
    return { usage: 1, basis: `one ${stockName} per part` };
  }
  const sized = sizedStock(input, stockName);
  if (!sized) {
    return null;
  }
  const { dims, stock } = sized;
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

/** The part's longest dimension in inches, from the drawing's envelope. */
export const partLengthIn = (
  envelope: {
    diameter?: number | null;
    h?: number | null;
    l?: number | null;
    length?: number | null;
    w?: number | null;
  } | null,
  units: "in" | "mm" | null
) => {
  if (!envelope) {
    return null;
  }
  const longest = Math.max(
    envelope.length ?? 0,
    envelope.l ?? 0,
    envelope.w ?? 0,
    envelope.h ?? 0
  );
  if (!(longest > 0)) {
    return null;
  }
  return units === "mm" ? longest / MM_PER_IN : longest;
};

// ---------------------------------------------------------------------------
// Material price
