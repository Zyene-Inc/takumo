// Merging and splitting RFQ lines (docs/PRODUCT-PLAN.md F2.2-R8): a drawing
// can list several parts, or the same part twice. The estimator decides.
// Pure, so tested.

import { MAX_QTY_BREAKS } from "./types";

export interface LineFields {
  description: string | null;
  drawing: unknown;
  fileId: string | null;
  finish: string | null;
  materialId: string | null;
  materialText: string | null;
  notes: string | null;
  partId: string | null;
  partNo: string | null;
  qtys: number[];
  rev: string | null;
  tolerances: string | null;
}

const TEXT_FIELDS = [
  "partNo",
  "rev",
  "description",
  "materialText",
  "finish",
  "tolerances",
  "notes",
  "partId",
  "materialId",
  "fileId",
] as const;

/** Every quantity either line asks for, smallest first, up to the limit. */
const mergeQtys = (a: number[], b: number[]) =>
  [...new Set([...a, ...b].filter((q) => q > 0))]
    .sort((x, y) => x - y)
    .slice(0, MAX_QTY_BREAKS);

/**
 * One line from two: the kept line's values win, the other fills its gaps.
 * `requantified` says the quantities changed (the estimate must be redone).
 */
export const mergeLines = (keep: LineFields, drop: LineFields) => {
  const merged = { ...keep };
  for (const key of TEXT_FIELDS) {
    merged[key] = keep[key] ?? drop[key];
  }
  merged.drawing = keep.drawing ?? drop.drawing;
  merged.qtys = mergeQtys(keep.qtys, drop.qtys);
  const requantified =
    merged.qtys.length !== keep.qtys.length ||
    merged.qtys.some((q, i) => q !== keep.qtys[i]);
  return { merged, requantified };
};

/** A copy of a line to be made into a second part: everything but its identity. */
export const splitLine = (line: LineFields, lineNo: number): LineFields => ({
  ...line,
  partNo: null,
  rev: null,
  partId: null,
  notes: `Split from line ${lineNo}. Set its part number.`,
});
