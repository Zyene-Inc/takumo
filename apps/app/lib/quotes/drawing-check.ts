// What a drawing asks of the shop, checked against what the shop can do
// (docs/PRODUCT-PLAN.md F2.2-R5/R7/R8): "check this" flags for the estimator,
// questions for the customer, and which RFQ line each drawn part belongs to.
// Pure, so tested.

import {
  type CheckContext,
  certificationFlags,
  confidenceChecks,
  conflictChecks,
  envelopeFlags,
  type Found,
  finishFlags,
  flagAt,
  label,
  materialFlags,
  scanChecks,
  toleranceFlags,
} from "./drawing-flags";
import { tightestTolerance } from "./drawing-measure";
import { normalizePartNo } from "./match";
import type { DrawingFlag, DrawingReading } from "./types";

export type { CheckContext } from "./drawing-flags";
export {
  machineEnvelope,
  plusMinusInches,
  tightestTolerance,
} from "./drawing-measure";

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
  const scan = scanChecks(reading);
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
    ...scan.flags,
    ...unclear.flags,
    ...conflicts.flags,
  ];
  const questions = [
    ...scan.questions,
    ...unclear.questions,
    ...conflicts.questions,
  ];
  if (!reading.material) {
    questions.push(
      `What material should ${label(reading)} be made from? The drawing doesn't say.`
    );
  }
  return { flags, questions };
};

/** A 2D CAD file (DXF, DWG): kept, but not a drawing Takumo can read. */
const CAD_FILE = /\.(dxf|dwg)$/i;

/** A drawing for a 3D-only RFQ line: nothing to read, one question to ask. */
export const noDrawingReading = (
  file: { id: string; name: string },
  partNo: string | null,
  readAt: string
): DrawingReading => {
  const what = CAD_FILE.test(file.name) ? "CAD file" : "3D model";
  const message = `No PDF drawing came with ${partNo ?? "this part"}, only a ${what} (${file.name}).`;
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
      `Could you send a PDF drawing for ${partNo ?? "the part"}? We received only the ${what}, and need the drawing for tolerances, finish and notes.`,
    ],
  };
};

// --- Which RFQ line each drawn part belongs to (R8) --------------------------

interface LineRef {
  id: string;
  partNo: string | null;
}

interface Assignment<P> {
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
const toleranceSummary = (reading: DrawingReading) => {
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
