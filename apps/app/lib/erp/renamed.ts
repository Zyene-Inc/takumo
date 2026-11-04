// When the ERP renames, adds or drops a column, the nightly report arrives
// with a new header row and isn't recognised (docs/PRODUCT-PLAN.md F1.3 edge
// cases). Most of its columns still match a report the shop already
// confirmed: carry that report's choices over, so the admin confirms the
// change in one click instead of mapping it again. Pure, so tested.

import {
  type ColumnMapping,
  missingRequired,
  normalizeHeader,
  suggestMapping,
} from "@repo/ingest";

/** At least this share of the columns must be the same report's. */
const MIN_SHARED = 0.6;
/** And at least this many, so two tiny reports aren't taken for each other. */
const MIN_SHARED_COLUMNS = 2;
/** How alike an old and a new header must be to be the same column renamed. */
const MIN_ALIKE = 0.5;

export interface KnownReport {
  headers: string[];
  id: string;
  mapping: ColumnMapping;
  mode: string;
  name: string;
}

export interface Renamed {
  /** Columns added to the report that no field uses. */
  added: string[];
  /** True when every required field still has a column: one click is enough. */
  complete: boolean;
  /** The confirmed report's choices, moved onto the new columns. */
  mapping: ColumnMapping;
  mode: string;
  /** Columns that are gone and fed a field nothing replaced. */
  removed: string[];
  /** Old column → new column, for columns that fed a field. */
  renamed: { from: string; to: string }[];
  report: { id: string; name: string };
}

const words = (h: string) => new Set(normalizeHeader(h).split(" "));

/** 0–1: "Due" and "Due Date" are alike; "Qty" and "Customer" aren't. */
export const alike = (a: string, b: string) => {
  const x = normalizeHeader(a);
  const y = normalizeHeader(b);
  if (!(x && y)) {
    return 0;
  }
  if (x === y) {
    return 1;
  }
  if (` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `)) {
    return 0.8;
  }
  const wx = words(a);
  const wy = words(b);
  const shared = [...wx].filter((w) => wy.has(w)).length;
  return shared / new Set([...wx, ...wy]).size;
};

/** The report these headers most likely are, if most columns match. */
const closest = (headers: string[], reports: KnownReport[]) => {
  const now = new Set(headers.map(normalizeHeader));
  let best: { report: KnownReport; share: number } | null = null;
  for (const report of reports) {
    const before = new Set(report.headers.map(normalizeHeader));
    const shared = [...now].filter((h) => before.has(h)).length;
    const share = shared / Math.max(now.size, before.size);
    if (
      shared >= MIN_SHARED_COLUMNS &&
      share >= MIN_SHARED &&
      (!best || share > best.share)
    ) {
      best = { report, share };
    }
  }
  return best?.report ?? null;
};

/** The new header that best replaces a gone one, among those still free. */
const replacement = (
  field: string,
  gone: string,
  free: string[],
  mapping: ColumnMapping
) => {
  let best: { header: string; score: number } | null = null;
  for (const header of free) {
    const score = alike(gone, header);
    if (score >= MIN_ALIKE && (!best || score > best.score)) {
      best = { header, score };
    }
  }
  if (best) {
    return best.header;
  }
  // Renamed to something unlike the old name: the field's own synonyms.
  return suggestMapping(mapping.entity, free).columns[field] ?? null;
};

/**
 * If a report that arrived with unknown columns is a confirmed report with
 * some columns renamed, added or dropped: which one, and its choices moved
 * onto the new columns.
 */
export const findRenamed = (
  headers: string[],
  reports: KnownReport[]
): Renamed | null => {
  const report = closest(headers, reports);
  if (!report) {
    return null;
  }
  const byName = new Map(headers.map((h) => [normalizeHeader(h), h]));
  const before = new Set(report.headers.map(normalizeHeader));
  // Only columns the report didn't have can be a renamed one: a column it
  // always had, that the shop chose not to use, isn't.
  const fresh = headers.filter((h) => !before.has(normalizeHeader(h)));
  const columns: Record<string, string | null> = {};
  const orphans: { field: string; gone: string }[] = [];
  for (const [field, header] of Object.entries(report.mapping.columns)) {
    const kept = header ? byName.get(normalizeHeader(header)) : undefined;
    columns[field] = kept ?? null;
    if (header && !kept) {
      orphans.push({ field, gone: header });
    }
  }
  const used = () => new Set(Object.values(columns).filter(Boolean));
  const renamed: Renamed["renamed"] = [];
  const removed: string[] = [];
  for (const { field, gone } of orphans) {
    const taken = used();
    const free = fresh.filter((h) => !taken.has(h));
    // One column gone, one new: the same column, whatever it's called now.
    const only =
      orphans.length === 1 && free.length === 1 ? free[0] : undefined;
    const to = replacement(field, gone, free, report.mapping) ?? only ?? null;
    columns[field] = to;
    if (to) {
      renamed.push({ from: gone, to });
    } else {
      removed.push(gone);
    }
  }
  const taken = used();
  const mapping: ColumnMapping = {
    ...report.mapping,
    columns,
    // Hours or minutes follow the field, whatever its column is called now.
    timeUnits: { ...report.mapping.timeUnits },
  };
  return {
    report: { id: report.id, name: report.name },
    mode: report.mode,
    mapping,
    renamed,
    removed,
    added: fresh.filter((h) => !taken.has(h)),
    complete: missingRequired(mapping).length === 0,
  };
};

/** "Due → Due Date; Notes dropped; Shift added", for the email and page. */
export const describeRenamed = (r: {
  added: string[];
  removed: string[];
  renamed: { from: string; to: string }[];
}) =>
  [
    ...r.renamed.map((x) => `"${x.from}" is now "${x.to}"`),
    ...r.removed.map((x) => `"${x}" is gone`),
    ...r.added.map((x) => `"${x}" is new`),
  ].join("; ");
