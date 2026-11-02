// What the drawing reader returns, and how it's cleaned into DrawingReading
// (docs/PRODUCT-PLAN.md F2.2-R2/R3). Pure, so tested without a model.

import { z } from "zod";
import { normalizePartNo } from "./match";
import type {
  Box,
  Confidence,
  DrawingReading,
  DrawingValue,
  FeatureKind,
  FinishKind,
  RequirementKind,
} from "./types";

const CONFIDENCE = ["high", "medium", "low"] as const;
const FINISH_KINDS = [
  "anodize",
  "plating",
  "heat_treat",
  "passivation",
  "paint",
  "other",
] as const satisfies readonly FinishKind[];
const FEATURE_KINDS = [
  "hole",
  "thread",
  "pocket",
  "slot",
  "bore",
  "chamfer",
  "radius",
  "knurl",
  "keyway",
  "other",
] as const satisfies readonly FeatureKind[];
const REQUIREMENT_KINDS = [
  "certification",
  "fai",
  "coc",
  "material_cert",
  "itar",
  "spec",
  "other",
] as const satisfies readonly RequirementKind[];

// --- The model's answer -----------------------------------------------------

const field = {
  text: z.string().describe("Exactly as printed on the drawing"),
  confidence: z.enum(CONFIDENCE),
  sheet: z
    .number()
    .int()
    .describe("The page in this file where it was read, from 1"),
  box: z
    .array(z.number())
    .nullable()
    .describe(
      "Where on that page: [ymin, xmin, ymax, xmax], each 0-1000 of the page height/width"
    ),
};

const value = z.object({
  ...field,
  value: z
    .string()
    .nullable()
    .describe("The value cleaned up (e.g. 'C' for 'REV C')"),
});

export const rawPartSchema = z.object({
  partNo: value.nullable(),
  rev: value.nullable(),
  title: value.nullable(),
  drawingNo: value.nullable(),
  scale: value.nullable(),
  sheetOf: value.nullable().describe("'SHEET 1 OF 2' as printed"),
  generalTolerance: value
    .nullable()
    .describe("The title block's tolerance block, verbatim"),
  drawnDate: value.nullable(),
  approvedDate: value.nullable(),
  material: z
    .object({
      ...field,
      grade: z.string().nullable().describe("e.g. '6061', '316', '4140'"),
      condition: z.string().nullable().describe("e.g. 'T6', 'annealed'"),
      spec: z.string().nullable().describe("e.g. 'AMS-QQ-A-250/11'"),
    })
    .nullable(),
  finishes: z.array(
    z.object({
      ...field,
      kind: z.enum(FINISH_KINDS),
      spec: z.string().nullable().describe("e.g. 'MIL-A-8625 TYPE II CL 1'"),
    })
  ),
  envelope: z
    .object({
      ...field,
      l: z.number().nullable(),
      w: z.number().nullable(),
      h: z.number().nullable(),
      diameter: z.number().nullable(),
      length: z.number().nullable(),
    })
    .nullable()
    .describe(
      "Overall size in the drawing's own units: l × w × h, or diameter × length for round parts"
    ),
  stock: z
    .object({
      form: z.enum(["bar", "plate", "tube", "sheet", "other"]),
      size: z.string().describe("e.g. '2.0 dia bar', '1 x 4 plate'"),
    })
    .nullable()
    .describe("Raw stock you'd cut this from (a suggestion)"),
  features: z.array(
    z.object({
      ...field,
      kind: z.enum(FEATURE_KINDS),
      count: z.number().int(),
      detail: z
        .string()
        .nullable()
        .describe("size, thru/blind, thread spec and depth"),
    })
  ),
  tolerances: z.array(
    z.object({
      ...field,
      kind: z.enum(["dimension", "gdt", "surface"]),
      tolerance: z
        .number()
        .nullable()
        .describe(
          "Dimension: the ± half-band in drawing units (+.001/-.000 → 0.0005). GD&T: the zone value. Surface: Ra"
        ),
      symbol: z
        .string()
        .nullable()
        .describe("GD&T symbol name, e.g. 'position', 'flatness'"),
      datums: z.array(z.string()),
    })
  ),
  notes: z.array(
    z.object({ ...field }).describe("A numbered drawing note, verbatim")
  ),
  requirements: z.array(
    z.object({
      ...field,
      kind: z.enum(REQUIREMENT_KINDS),
    })
  ),
  quantities: z.array(z.object({ ...field, qty: z.number().int() })),
});

export const drawingAnswerSchema = z.object({
  units: z
    .enum(["in", "mm", "unknown"])
    .describe("The drawing's dimension units"),
  parts: z
    .array(rawPartSchema)
    .describe("One entry per part number on these pages"),
});

export type RawPart = z.infer<typeof rawPartSchema>;
export type DrawingAnswer = z.infer<typeof drawingAnswerSchema>;

// --- Cleaning ---------------------------------------------------------------

const clamp = (n: number) => Math.min(1000, Math.max(0, Math.round(n)));

/** A usable box, or null: four finite numbers, clamped, in order. */
export const cleanBox = (box: number[] | null | undefined): Box | null => {
  if (!box || box.length !== 4 || !box.every(Number.isFinite)) {
    return null;
  }
  const [a, b, c, d] = box.map(clamp);
  const ymin = Math.min(a, c);
  const ymax = Math.max(a, c);
  const xmin = Math.min(b, d);
  const xmax = Math.max(b, d);
  if (ymin === ymax || xmin === xmax) {
    return null;
  }
  return [ymin, xmin, ymax, xmax];
};

const confidence = (c: string | undefined): Confidence =>
  (CONFIDENCE as readonly string[]).includes(c ?? "")
    ? (c as Confidence)
    : "low";

interface Context {
  /** Page the answer's page 1 is in the file (groups of pages are read apart). */
  firstSheet: number;
  /** Pages in the whole file. */
  sheets: number;
}

const sheetOf = (sheet: number, ctx: Context) =>
  Math.min(
    ctx.sheets,
    Math.max(1, Math.round(ctx.firstSheet + (Number(sheet) || 1) - 1))
  );

const trimmed = (s: string | null | undefined) => {
  const t = s?.trim();
  return t ? t : null;
};

/** The shared parts of a value; null when nothing was read. */
const base = <T>(raw: Raw, v: T, ctx: Context): DrawingValue<T> | null => {
  const text = trimmed(raw.text);
  if (!text) {
    return null;
  }
  return {
    text,
    value: v,
    confidence: confidence(raw.confidence),
    sheet: sheetOf(raw.sheet, ctx),
    box: cleanBox(raw.box),
  };
};

interface Raw {
  box: number[] | null;
  confidence: Confidence;
  sheet: number;
  text: string;
}

const textValue = (
  raw: z.infer<typeof value> | null | undefined,
  ctx: Context
): DrawingValue | undefined => {
  if (!raw) {
    return undefined;
  }
  const v = trimmed(raw.value) ?? trimmed(raw.text);
  return v ? (base(raw, v, ctx) ?? undefined) : undefined;
};

const positive = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;

/** One part from one group of pages, cleaned. */
export type PartReading = Omit<
  DrawingReading,
  "fileId" | "fileName" | "readAt" | "sheets" | "units" | "flags" | "questions"
>;

type Envelope = NonNullable<DrawingReading["envelope"]>["value"];

export const cleanPart = (raw: RawPart, ctx: Context): PartReading => {
  const envelope = raw.envelope
    ? (() => {
        const dims = {
          l: positive(raw.envelope.l),
          w: positive(raw.envelope.w),
          h: positive(raw.envelope.h),
          diameter: positive(raw.envelope.diameter),
          length: positive(raw.envelope.length),
        };
        const kept = Object.fromEntries(
          Object.entries(dims).filter(([, n]) => n !== undefined)
        ) as Envelope;
        return Object.keys(kept).length ? base(raw.envelope, kept, ctx) : null;
      })()
    : null;
  const material = raw.material
    ? (() => {
        const b = base(raw.material, raw.material.text.trim(), ctx);
        return b
          ? {
              ...b,
              grade: trimmed(raw.material.grade),
              condition: trimmed(raw.material.condition),
              spec: trimmed(raw.material.spec),
            }
          : null;
      })()
    : null;
  const titleBlock: DrawingReading["titleBlock"] = {};
  const tb = {
    partNo: raw.partNo,
    rev: raw.rev,
    title: raw.title,
    drawingNo: raw.drawingNo,
    scale: raw.scale,
    sheet: raw.sheetOf,
    generalTolerance: raw.generalTolerance,
    drawnDate: raw.drawnDate,
    approvedDate: raw.approvedDate,
  } as const;
  for (const [key, v] of Object.entries(tb)) {
    const cleaned = textValue(v, ctx);
    if (cleaned) {
      titleBlock[key as keyof typeof tb] = cleaned;
    }
  }
  const list = <R extends Raw, O>(
    items: R[],
    make: (r: R, b: DrawingValue) => O
  ): O[] =>
    items.flatMap((r) => {
      const b = base(r, r.text.trim(), ctx);
      return b ? [make(r, b)] : [];
    });
  return {
    titleBlock,
    material,
    finishes: list(raw.finishes, (r, b) => ({
      ...b,
      kind: r.kind,
      spec: trimmed(r.spec),
    })),
    envelope,
    stock: raw.stock?.size?.trim()
      ? { form: raw.stock.form, size: raw.stock.size.trim() }
      : null,
    features: list(raw.features, (r, b) => ({
      ...b,
      kind: r.kind,
      count: Math.max(1, Math.round(r.count || 1)),
      detail: trimmed(r.detail),
    })),
    tolerances: list(raw.tolerances, (r, b) => ({
      ...b,
      kind: r.kind,
      tolerance: positive(r.tolerance) ?? null,
      symbol: trimmed(r.symbol),
      datums: r.datums.map((d) => d.trim()).filter(Boolean),
    })),
    notes: list(raw.notes, (_r, b) => b),
    requirements: list(raw.requirements, (r, b) => ({ ...b, kind: r.kind })),
    quantities: raw.quantities.flatMap((q) => {
      const n = Math.round(q.qty);
      const b = n > 0 ? base(q, n, ctx) : null;
      return b ? [b] : [];
    }),
  };
};

/** The number a part goes by on the drawing: part number, else drawing number. */
export const partKey = (p: Pick<PartReading, "titleBlock">) =>
  normalizePartNo(
    p.titleBlock.partNo?.value ?? p.titleBlock.drawingNo?.value ?? ""
  );

const better = <T extends DrawingValue<unknown>>(
  a: T | undefined,
  b: T | undefined
) => {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  const rank = { high: 3, medium: 2, low: 1 } as const;
  return rank[b.confidence] > rank[a.confidence] ? b : a;
};

/**
 * Parts read from separate groups of pages, joined by part number. A page
 * group with no part number joins the only part, when there's just one.
 */
export const mergeParts = (parts: PartReading[]): PartReading[] => {
  const byKey = new Map<string, PartReading>();
  const unnamed: PartReading[] = [];
  for (const p of parts) {
    const key = partKey(p);
    if (!key) {
      unnamed.push(p);
      continue;
    }
    const have = byKey.get(key);
    byKey.set(key, have ? joinParts(have, p) : p);
  }
  const named = [...byKey.values()];
  if (named.length === 1) {
    return [unnamed.reduce(joinParts, named[0])];
  }
  if (named.length === 0 && unnamed.length) {
    return [unnamed.reduce(joinParts)];
  }
  // Several parts: pages without a part number can't be placed; their
  // values are dropped rather than given to the wrong part.
  return named;
};

const joinParts = (a: PartReading, b: PartReading): PartReading => {
  const titleBlock = { ...a.titleBlock };
  for (const [k, v] of Object.entries(b.titleBlock)) {
    const key = k as keyof PartReading["titleBlock"];
    titleBlock[key] = better(titleBlock[key], v);
  }
  return {
    titleBlock,
    material: better(a.material ?? undefined, b.material ?? undefined) ?? null,
    envelope: better(a.envelope ?? undefined, b.envelope ?? undefined) ?? null,
    stock: a.stock ?? b.stock,
    finishes: [...a.finishes, ...b.finishes],
    features: [...a.features, ...b.features],
    tolerances: [...a.tolerances, ...b.tolerances],
    notes: [...a.notes, ...b.notes],
    requirements: [...a.requirements, ...b.requirements],
    quantities: [...a.quantities, ...b.quantities],
  };
};
