// What a drawing asks of the shop, checked against what the shop can do
// (docs/PRODUCT-PLAN.md F2.2-R5/R7/R8): "check this" flags for the estimator,
// questions for the customer, and which RFQ line each drawn part belongs to.
// Pure, so tested.

import { normalizePartNo } from "./match";
import type {
  DrawingFlag,
  DrawingReading,
  DrawingValue,
  OutsideSupplier,
} from "./types";

const MM_PER_IN = 25.4;

/** A length in the drawing's units, in inches (for checks only; never shown). */
export const toInches = (n: number, units: DrawingReading["units"]) =>
  units === "mm" ? n / MM_PER_IN : n;

type Tolerance = DrawingReading["tolerances"][number];

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

interface Rect {
  dims: number[];
  kind: "rect";
}
interface Round {
  diameter: number;
  kind: "round";
  length: number;
}

const num = (v: unknown) =>
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
const partSize = (reading: DrawingReading) => {
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

export interface CheckContext {
  /** Certifications the shop holds (QuoteSettings.certifications). */
  certifications: string[];
  /** The RFQ line the drawing was matched to, as the customer wrote it. */
  line: {
    finish: string | null;
    materialText: string | null;
    partNo: string | null;
    rev: string | null;
  } | null;
  machines: { envelope: unknown; name: string; toleranceIn: number | null }[];
  /** The material matched a Material the shop has (or has bought). */
  materialKnown: boolean;
  outsideProcesses: Pick<OutsideSupplier, "process" | "supplier">[];
  /** QuoteSettings.toleranceIn */
  shopToleranceIn: number;
}

const NOT_ALNUM = /[^a-z0-9]+/g;
const GRADE = /\b[a-z]?\d{3,4}\b/g;
const WORD = /[a-z0-9]+/g;

const squash = (s: string) => s.toLowerCase().replace(NOT_ALNUM, "");

/**
 * Two ways of writing the same thing ("6061-T6 AL" vs "AL 6061-T6 PER AMS…"):
 * one contains the other, or the grades agree and most words are shared.
 */
export const sameText = (a: string, b: string) => {
  const x = squash(a);
  const y = squash(b);
  if (!(x && y)) {
    return true;
  }
  if (x.includes(y) || y.includes(x)) {
    return true;
  }
  const ga = new Set(a.toLowerCase().match(GRADE) ?? []);
  const gb = new Set(b.toLowerCase().match(GRADE) ?? []);
  if (ga.size && gb.size) {
    return [...ga].some((g) => gb.has(g));
  }
  const wa = new Set(a.toLowerCase().match(WORD) ?? []);
  const wb = new Set(b.toLowerCase().match(WORD) ?? []);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / Math.max(1, Math.min(wa.size, wb.size)) >= 0.6;
};

const REV_WORD = /^rev(ision)?/;
const AS9100 = /^(as9100)[a-z]*$/;
const ISO = /^(iso\d{4,5}).*$/;
const IATF = /^(iatf16949).*$/;

const sameRev = (a: string, b: string) =>
  squash(a).replace(REV_WORD, "") === squash(b).replace(REV_WORD, "");

const at = (v: DrawingValue<unknown> | null | undefined) =>
  v ? { sheet: v.sheet, box: v.box } : { sheet: null, box: null };

const inches = (n: number) =>
  `±${n.toLocaleString("en-US", { maximumSignificantDigits: 3 })} in`;

const FINISH_WORDS: Record<string, string[]> = {
  anodize: ["anodize", "anodizing", "anodise", "anod"],
  plating: ["plate", "plating", "zinc", "nickel", "chrome", "cadmium"],
  heat_treat: ["heat", "harden", "temper", "nitride", "carburize"],
  passivation: ["passivate", "passivation"],
  paint: ["paint", "powder", "coat", "primer"],
};

/** The outside supplier for a finish, if the shop has one for it. */
export const supplierFor = (
  finish: DrawingReading["finishes"][number],
  suppliers: CheckContext["outsideProcesses"]
) => {
  const text = `${finish.text} ${finish.spec ?? ""}`.toLowerCase();
  const kindWords = FINISH_WORDS[finish.kind] ?? [];
  return (
    suppliers.find((s) => {
      const process = s.process.toLowerCase();
      const words = process.match(WORD) ?? [];
      return (
        words.some((w) => w.length > 3 && text.includes(w)) ||
        kindWords.some((w) => process.includes(w))
      );
    }) ?? null
  );
};

const CERT_NAME =
  /\b(as\s?9100\w*|iso\s?9001|iso\s?13485|nadcap|itar|iatf\s?16949|ear)\b/i;
const CERT_NAMES = new RegExp(CERT_NAME.source, "gi");

/** "AS9100D", "AS9100 Rev D", "ISO 9001:2015" → "as9100", "iso9001". */
const certKey = (s: string) =>
  squash(s.match(CERT_NAME)?.[0] ?? s)
    .replace(AS9100, "$1")
    .replace(ISO, "$1")
    .replace(IATF, "$1");

const label = (reading: DrawingReading) =>
  reading.titleBlock.partNo?.value ??
  reading.titleBlock.drawingNo?.value ??
  "this part";

const KEY_VALUES = (r: DrawingReading) =>
  [
    ["part number", r.titleBlock.partNo],
    ["revision", r.titleBlock.rev],
    ["material", r.material],
    ...r.finishes.map((f) => ["finish", f] as const),
    ["overall size", r.envelope],
  ] as const;

interface Found {
  flags: DrawingFlag[];
  questions: string[];
}

const flagAt = (
  kind: DrawingFlag["kind"],
  message: string,
  where: DrawingValue<unknown> | null | undefined = null
): DrawingFlag => ({ kind, message, ...at(where) });

const materialFlags = (r: DrawingReading, ctx: CheckContext) =>
  r.material && !ctx.materialKnown
    ? [
        flagAt(
          "new_material",
          `${r.material.text}: not a material you've bought before. Check its price and lead time.`,
          r.material
        ),
      ]
    : [];

const finishFlags = (r: DrawingReading, ctx: CheckContext) =>
  r.finishes.map((finish) => {
    const supplier = supplierFor(finish, ctx.outsideProcesses);
    return flagAt(
      "outsourced",
      supplier
        ? `${finish.text}: you send this out${supplier.supplier ? ` (${supplier.supplier})` : ""}. Add its cost and lead time.`
        : `${finish.text}: is this done in house? If it goes out, add the supplier under Settings → Quoting.`,
      finish
    );
  });

const toleranceFlags = (r: DrawingReading, ctx: CheckContext) => {
  const machineTols = ctx.machines
    .map((m) => m.toleranceIn)
    .filter((t): t is number => typeof t === "number" && t > 0);
  const capability = Math.min(ctx.shopToleranceIn, ...machineTols);
  const tight = tightestTolerance(r);
  const tightIn = tight ? plusMinusInches(tight, r.units) : null;
  return tight && tightIn !== null && tightIn < capability - 1e-12
    ? [
        flagAt(
          "tolerance",
          `${tight.text}: tighter than the ${inches(capability)} you hold.`,
          tight
        ),
      ]
    : [];
};

const envelopeFlags = (r: DrawingReading, ctx: CheckContext) => {
  const size = partSize(r);
  const envelopes = ctx.machines
    .map((m) => machineEnvelope(m.envelope))
    .filter((e): e is Rect | Round => e !== null);
  return size && envelopes.length && !envelopes.some((e) => fits(size, e))
    ? [
        flagAt(
          "envelope",
          `${r.envelope?.text ?? "Overall size"}: larger than any machine you've given a size for.`,
          r.envelope
        ),
      ]
    : [];
};

const certificationFlags = (r: DrawingReading, ctx: CheckContext) => {
  const held = new Set(ctx.certifications.map(certKey));
  const seen = new Set<string>();
  const flags: DrawingFlag[] = [];
  for (const req of r.requirements) {
    if (!(req.kind === "certification" || req.kind === "itar")) {
      continue;
    }
    const names = req.text.match(CERT_NAMES) ?? [
      req.kind === "itar" ? "ITAR" : req.text,
    ];
    for (const n of names) {
      const key = certKey(n);
      if (!(held.has(key) || seen.has(key))) {
        seen.add(key);
        flags.push(
          flagAt(
            "certification",
            `Requires ${n.toUpperCase()}: not marked as held under Settings → Quoting.`,
            req
          )
        );
      }
    }
  }
  return flags;
};

const confidenceChecks = (r: DrawingReading): Found => {
  const name = label(r);
  const found: Found = { flags: [], questions: [] };
  for (const [what, v] of KEY_VALUES(r)) {
    if (v?.confidence !== "low") {
      continue;
    }
    found.flags.push(
      flagAt(
        "low_confidence",
        `The ${what} was hard to read ("${v.text}"). Check it on the drawing.`,
        v
      )
    );
    if (what !== "part number" && what !== "overall size") {
      found.questions.push(
        `For ${name}, please confirm the ${what}: we read it as "${v.text}".`
      );
    }
  }
  return found;
};

/** Where the drawing and the RFQ line disagree. */
const conflictChecks = (r: DrawingReading, ctx: CheckContext): Found => {
  const found: Found = { flags: [], questions: [] };
  const line = ctx.line;
  if (!line) {
    return found;
  }
  const name = label(r);
  const differ = (
    where: DrawingValue<unknown> | null | undefined,
    message: string,
    question: string | null
  ) => {
    found.flags.push(flagAt("conflict", message, where));
    if (question) {
      found.questions.push(question);
    }
  };
  const rev = r.titleBlock.rev;
  if (line.rev && rev && !sameRev(line.rev, rev.value)) {
    differ(
      rev,
      `The drawing is rev ${rev.value}, the RFQ says rev ${line.rev}.`,
      `The drawing for ${name} shows revision ${rev.value}, but the request says revision ${line.rev}. Which revision should we quote?`
    );
  }
  if (
    line.materialText &&
    r.material &&
    !sameText(line.materialText, r.material.text)
  ) {
    differ(
      r.material,
      `The drawing calls for ${r.material.text}, the RFQ says ${line.materialText}.`,
      `For ${name}, the drawing calls for ${r.material.text} but the request says ${line.materialText}. Which material should we quote?`
    );
  }
  const finish = line.finish;
  if (
    finish &&
    r.finishes.length &&
    !r.finishes.some((f) => sameText(finish, f.text))
  ) {
    const drawn = r.finishes.map((f) => f.text).join("; ");
    differ(
      r.finishes[0],
      `The drawing's finish is ${drawn}, the RFQ says ${finish}.`,
      `For ${name}, the drawing specifies ${drawn} but the request says ${finish}. Which finish should we quote?`
    );
  }
  const drawnNo = r.titleBlock.partNo?.value;
  const lineNo = line.partNo ? normalizePartNo(line.partNo) : null;
  if (
    lineNo &&
    drawnNo &&
    lineNo !== normalizePartNo(drawnNo) &&
    lineNo !== normalizePartNo(r.titleBlock.drawingNo?.value ?? "")
  ) {
    differ(
      r.titleBlock.partNo,
      `The drawing's part number is ${drawnNo}, the RFQ line says ${line.partNo}.`,
      null
    );
  }
  return found;
};

/**
 * Flags for the estimator and questions for the customer. Every flag points
 * at where on the drawing it came from.
 */
export const checkDrawing = (
  reading: DrawingReading,
  ctx: CheckContext
): Found => {
  const unclear = confidenceChecks(reading);
  const conflicts = conflictChecks(reading, ctx);
  const flags: DrawingFlag[] = [
    ...(reading.units === "mm"
      ? [
          flagAt(
            "units",
            "Metric drawing: sizes and tolerances are shown in mm, as printed. Nothing was converted."
          ),
        ]
      : []),
    ...materialFlags(reading, ctx),
    ...finishFlags(reading, ctx),
    ...toleranceFlags(reading, ctx),
    ...envelopeFlags(reading, ctx),
    ...certificationFlags(reading, ctx),
    ...unclear.flags,
    ...conflicts.flags,
  ];
  const questions = [...unclear.questions, ...conflicts.questions];
  if (!reading.material) {
    questions.push(
      `What material should ${label(reading)} be made from? The drawing doesn't say.`
    );
  }
  return { flags, questions };
};

/** A drawing for a 3D-only RFQ line: nothing to read, one question to ask. */
export const noDrawingReading = (
  file: { id: string; name: string },
  partNo: string | null,
  readAt: string
): DrawingReading => {
  const message = `No drawing came with ${partNo ?? "this part"}, only a 3D model (${file.name}).`;
  return {
    fileId: file.id,
    fileName: file.name,
    readAt,
    sheets: 0,
    units: null,
    titleBlock: {},
    material: null,
    finishes: [],
    envelope: null,
    stock: null,
    features: [],
    tolerances: [],
    notes: [],
    requirements: [],
    quantities: [],
    flags: [{ kind: "no_drawing", message, sheet: null, box: null }],
    questions: [
      `Could you send a PDF drawing for ${partNo ?? "the part"}? We received only the 3D model, and need the drawing for tolerances, finish and notes.`,
    ],
  };
};

// --- Which RFQ line each drawn part belongs to (R8) --------------------------

export interface LineRef {
  id: string;
  partNo: string | null;
}

export interface Assignment<P> {
  /** Parts found on drawings that the RFQ text didn't list: new lines. */
  create: P[];
  /** Line id → the part read for it. */
  update: Map<string, P>;
}

const keysOf = (p: Pick<DrawingReading, "titleBlock">) =>
  [p.titleBlock.partNo?.value, p.titleBlock.drawingNo?.value]
    .map((v) => normalizePartNo(v ?? ""))
    .filter(Boolean);

/**
 * Match each part read from the drawings to an RFQ line by part (or drawing)
 * number. A single part and a single unmatched line go together when the
 * line has no number (or is the only one); any other part becomes a new line. A line keeps the first drawing found for it.
 */
export const assignParts = <P extends Pick<DrawingReading, "titleBlock">>(
  lines: LineRef[],
  parts: P[]
): Assignment<P> => {
  const update = new Map<string, P>();
  const leftover: P[] = [];
  for (const part of parts) {
    const keys = keysOf(part);
    const line = lines.find(
      (l) =>
        !update.has(l.id) &&
        l.partNo &&
        keys.includes(normalizePartNo(l.partNo))
    );
    if (line) {
      update.set(line.id, part);
    } else if (
      keys.length &&
      lines.some((l) => l.partNo && keys.includes(normalizePartNo(l.partNo)))
    ) {
      // The same part on a second drawing: the first one stands.
    } else {
      leftover.push(part);
    }
  }
  const free = lines.filter((l) => !update.has(l.id));
  // One drawn part and one line left: the same part under the customer's own
  // number, when that line has no number or is the RFQ's only line.
  if (
    leftover.length === 1 &&
    free.length === 1 &&
    (!free[0].partNo || lines.length === 1)
  ) {
    update.set(free[0].id, leftover[0]);
    return { update, create: [] };
  }
  return { update, create: leftover };
};

/** "±0.0005 (tightest), Ra 32" for RfqLine.tolerances. */
export const toleranceSummary = (reading: DrawingReading) => {
  const tight = tightestTolerance(reading);
  const surface = reading.tolerances
    .filter((t) => t.kind === "surface" && t.tolerance !== null)
    .sort((a, b) => (a.tolerance ?? 0) - (b.tolerance ?? 0))[0];
  const parts = [
    tight ? `${tight.text} (tightest)` : null,
    surface ? `surface ${surface.text}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
};

/**
 * What the drawing fills on its RFQ line: only fields the customer left
 * empty. Different values become "conflict" flags in checkDrawing instead.
 */
export const linePatch = (
  line: {
    finish: string | null;
    materialText: string | null;
    partNo: string | null;
    rev: string | null;
    tolerances: string | null;
  },
  reading: DrawingReading
) => {
  const patch: Partial<Record<keyof typeof line, string>> = {};
  const set = (key: keyof typeof line, v: string | null | undefined) => {
    if (!line[key] && v) {
      patch[key] = v;
    }
  };
  set("partNo", reading.titleBlock.partNo?.value);
  set("rev", reading.titleBlock.rev?.value);
  set("materialText", reading.material?.text);
  set(
    "finish",
    reading.finishes.length
      ? reading.finishes.map((f) => f.text).join("; ")
      : null
  );
  set("tolerances", toleranceSummary(reading));
  return patch;
};
