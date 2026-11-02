// Drawing reading against a design partner's answer key (docs/PRODUCT-PLAN.md
// F2.2 acceptance): material, revision and finish right on 90%, the tightest
// tolerance on 80%, and nothing silently wrong: a wrong value must have been
// shown as unclear (not high confidence). Pure, so tested.

import { plusMinusInches, tightestTolerance } from "@/lib/quotes/drawing-check";
import { normalizePartNo } from "@/lib/quotes/match";
import type {
  Confidence,
  DrawingReading,
  DrawingValue,
} from "@/lib/quotes/types";
import type { ExpectedLine } from "./answer-key";
import { sameThing } from "./compare";

export const DRAWING_TARGETS = {
  material: 0.9,
  rev: 0.9,
  finish: 0.9,
  tolerance: 0.8,
} as const;
export type DrawingField = keyof typeof DRAWING_TARGETS;

export interface FieldScore {
  /** null when the answer key has no value for it. */
  ok: boolean | null;
  read: string | null;
  /** Wrong, and shown as if certain. */
  silent: boolean;
}

export type DrawingScore = Record<DrawingField, FieldScore> & {
  found: boolean;
  partNo: string;
};

const TOLERANCE_SLACK = 1e-6;

/** The reading for an expected line: by part number, or the only one. */
export const readingFor = (
  expected: ExpectedLine,
  readings: DrawingReading[]
) => {
  const want = normalizePartNo(expected.partNo);
  return (
    readings.find((r) =>
      [r.titleBlock.partNo?.value, r.titleBlock.drawingNo?.value].some(
        (v) => v && normalizePartNo(v) === want
      )
    ) ?? (readings.length === 1 ? readings[0] : null)
  );
};

const score = (
  expected: string | number | null | undefined,
  read: DrawingValue<unknown> | null | undefined,
  same: (read: DrawingValue<unknown>) => boolean
): FieldScore => {
  if (expected === null || expected === undefined) {
    return { ok: null, read: read?.text ?? null, silent: false };
  }
  if (!read) {
    // Not read at all: a miss, but a visible one.
    return { ok: false, read: null, silent: false };
  }
  const ok = same(read);
  return { ok, read: read.text, silent: !ok && read.confidence === "high" };
};

const REV_WORD = /^rev(ision)?/;

const normRev = (s: string) => normalizePartNo(s).replace(REV_WORD, "");

/** As sure as the least sure of them. */
const leastSure = (values: { confidence: Confidence }[]): Confidence => {
  if (values.some((v) => v.confidence === "low")) {
    return "low";
  }
  return values.some((v) => v.confidence === "medium") ? "medium" : "high";
};

export const scoreDrawing = (
  expected: ExpectedLine,
  readings: DrawingReading[]
): DrawingScore => {
  const r = readingFor(expected, readings);
  const tight = r ? tightestTolerance(r) : null;
  const finishes = r?.finishes ?? [];
  const finish = finishes.length
    ? {
        ...finishes[0],
        text: finishes.map((f) => f.text).join("; "),
        confidence: leastSure(finishes),
      }
    : null;
  return {
    partNo: expected.partNo,
    found: Boolean(r),
    material: score(expected.material, r?.material, (v) =>
      Boolean(sameThing(expected.material, v.text))
    ),
    rev: score(
      expected.rev,
      r?.titleBlock.rev,
      (v) => normRev(String(v.value)) === normRev(expected.rev ?? "")
    ),
    finish: score(expected.finish, finish, (v) =>
      Boolean(sameThing(expected.finish, v.text))
    ),
    tolerance: score(expected.tightestTolerance, tight, () => {
      const inches = tight && r ? plusMinusInches(tight, r.units) : null;
      return (
        inches !== null &&
        Math.abs(inches - (expected.tightestTolerance ?? 0)) <=
          Math.max(TOLERANCE_SLACK, (expected.tightestTolerance ?? 0) * 0.01)
      );
    }),
  };
};

export interface DrawingSummary {
  fields: Record<
    DrawingField,
    { n: number; of: number; passes: boolean; target: number }
  >;
  passes: boolean;
  silentlyWrong: { field: DrawingField; partNo: string; read: string }[];
}

export const summarizeDrawings = (scores: DrawingScore[]): DrawingSummary => {
  const fields = {} as DrawingSummary["fields"];
  for (const field of Object.keys(DRAWING_TARGETS) as DrawingField[]) {
    const scored = scores.filter((s) => s[field].ok !== null);
    const n = scored.filter((s) => s[field].ok).length;
    const target = DRAWING_TARGETS[field];
    fields[field] = {
      n,
      of: scored.length,
      target,
      passes: scored.length > 0 && n / scored.length >= target,
    };
  }
  const silentlyWrong = scores.flatMap((s) =>
    (Object.keys(DRAWING_TARGETS) as DrawingField[])
      .filter((f) => s[f].silent)
      .map((f) => ({ field: f, partNo: s.partNo, read: s[f].read ?? "" }))
  );
  return {
    fields,
    silentlyWrong,
    passes:
      silentlyWrong.length === 0 &&
      Object.values(fields).every((f) => f.of === 0 || f.passes),
  };
};
