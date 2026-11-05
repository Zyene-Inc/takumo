// Sizes and tolerances from the drawing, in inches, against each machine.

import type { DrawingReading } from "./types";

export const MM_PER_IN = 25.4;

/** A length in the drawing's units, in inches (for checks only; never shown). */
export const toInches = (n: number, units: DrawingReading["units"]) =>
  units === "mm" ? n / MM_PER_IN : n;

export type Tolerance = DrawingReading["tolerances"][number];

/** A tolerance as ± inches: dimensions are ± already, GD&T zones are halved. */
export const plusMinusInches = (
  t: Tolerance,
  units: DrawingReading["units"]
): number | null => {
  if (t.tolerance === null || t.kind === "surface") {
    return null;
  }
  const half = t.kind === "gdt" ? t.tolerance / 2 : t.tolerance;
  return toInches(half, units);
};

/** The tightest dimensional or GD&T tolerance on the drawing. */
export const tightestTolerance = (
  reading: Pick<DrawingReading, "tolerances" | "units">
): Tolerance | null => {
  let best: Tolerance | null = null;
  let bestIn = Number.POSITIVE_INFINITY;
  for (const t of reading.tolerances) {
    const inches = plusMinusInches(t, reading.units);
    if (inches !== null && inches > 0 && inches < bestIn) {
      best = t;
      bestIn = inches;
    }
  }
  return best;
};

export interface Rect {
  dims: number[];
  kind: "rect";
}

export interface Round {
  diameter: number;
  kind: "round";
  length: number;
}

export const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

/** WorkCenter.envelope ({ x, y, z } or { diameter, length }, inches). */
export const machineEnvelope = (value: unknown): Rect | Round | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const e = value as Record<string, unknown>;
  const diameter = num(e.diameter);
  const length = num(e.length);
  if (diameter && length) {
    return { kind: "round", diameter, length };
  }
  const dims = [num(e.x), num(e.y), num(e.z)];
  if (dims.every((d) => d !== null)) {
    return { kind: "rect", dims: (dims as number[]).sort((a, b) => a - b) };
  }
  return null;
};

/** The part's size in inches, as a box (sorted) and, if round, as a cylinder. */
export const partSize = (reading: DrawingReading) => {
  const v = reading.envelope?.value;
  if (!v) {
    return null;
  }
  const inch = (n: number | undefined) =>
    n === undefined ? undefined : toInches(n, reading.units);
  const diameter = inch(v.diameter);
  const length = inch(v.length ?? v.l);
  if (diameter && length) {
    return {
      box: [diameter, diameter, length].sort((a, b) => a - b),
      round: { diameter, length },
    };
  }
  const dims = [inch(v.l), inch(v.w), inch(v.h)].filter(
    (d): d is number => d !== undefined
  );
  if (dims.length < 2) {
    return null;
  }
  // A flat part with no thickness given: assume it's thin.
  const box = (dims.length === 2 ? [0, ...dims] : dims).sort((a, b) => a - b);
  return { box, round: null };
};

/** Whether a part of this size fits the machine, in any orientation. */
export const fits = (
  part: NonNullable<ReturnType<typeof partSize>>,
  machine: Rect | Round
) => {
  if (machine.kind === "rect") {
    return part.box.every((d, i) => d <= machine.dims[i]);
  }
  // A lathe: round parts by diameter and length; others by their section.
  if (part.round) {
    return (
      part.round.diameter <= machine.diameter &&
      part.round.length <= machine.length
    );
  }
  const [a, b, c] = part.box;
  return Math.hypot(a, b) <= machine.diameter && c <= machine.length;
};
