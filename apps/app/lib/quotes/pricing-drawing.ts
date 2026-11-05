// The drawing, in words, for proposing operations (F2.3-R2).

import type { DrawingReading } from "./types";

export const envelopeLine = (d: DrawingReading) => {
  const e = d.envelope?.value;
  if (!e) {
    return null;
  }
  const size = e.diameter
    ? `Ø${e.diameter} × ${e.length ?? "?"}`
    : [e.l, e.w, e.h].filter((v) => v !== undefined).join(" × ");
  return size ? `Envelope: ${size}${d.units ? ` ${d.units}` : ""}` : null;
};

export const featureLine = (f: DrawingReading["features"][number]) =>
  `Feature: ${f.count} × ${f.kind}${f.detail ? ` (${f.detail})` : ""}${f.text ? `: ${f.text}` : ""}`;

/** The tightest few tolerances, tightest first. */
export const tightest = (d: DrawingReading, count = 4) =>
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
