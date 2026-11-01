// Takumo's draft against what the estimator really sent, and its delivery
// answer against the planner's. Uses the app's own "small edit" thresholds
// (lib/quotes/numbers.ts). Pure, so tested.

import {
  SMALL_LEAD_TIME_EDIT_DAYS,
  SMALL_PRICE_EDIT,
} from "@/lib/quotes/numbers";
import type { ExpectedLine, FeasibilityCase } from "./answer-key";

/** What Takumo read and drafted for one RFQ line. */
export interface DraftedLine {
  breaks: {
    leadTimeDays: number | null;
    qty: number;
    unitPrice: number | null;
  }[];
  finish: string | null;
  material: string | null;
  partNo: string | null;
  qtys: number[];
  rev: string | null;
}

export interface BreakResult {
  draftLeadTimeDays: number | null;
  draftUnitPrice: number | null;
  /** Draft minus sent, in days. */
  leadTimeDiffDays: number | null;
  leadTimeOk: boolean | null;
  /** Draft over sent, minus 1 (0.04 = 4% higher). */
  priceDiff: number | null;
  priceOk: boolean;
  qty: number;
  sentLeadTimeDays: number | null;
  sentUnitPrice: number;
}

export interface LineResult {
  breaks: BreakResult[];
  finishOk: boolean | null;
  found: boolean;
  materialOk: boolean | null;
  partNo: string;
  qtysOk: boolean;
  revOk: boolean | null;
}

const NOT_ALNUM = /[^A-Z0-9]/g;
const WORDS = /[a-z0-9]+/g;

const norm = (s: string | null | undefined) =>
  (s ?? "").toUpperCase().replace(NOT_ALNUM, "");

const words = (s: string) => new Set(s.toLowerCase().match(WORDS) ?? []);

// Shop shorthand, so "316 stainless" and "SS316 bar" read as the same thing.
const SYNONYMS: [RegExp, string][] = [
  [/\bstainless( steel)?\b|\bss(?=\d|\b)/g, " stainless "],
  [/\balumin(i)?um\b|\bal(?=\d|\b)/g, " aluminum "],
  [/\bcold[- ]rolled( steel)?\b|\bcrs\b/g, " crs "],
  [/\banodi[sz](e|ed|ing)\b/g, " anodize "],
  [/\bpassivat(e|ed|ion)\b/g, " passivate "],
];
// Alloy and spec numbers: 316, 6061, 4140, A967.
const GRADE = /\b[a-z]?\d{3,4}\b/g;

const canonical = (s: string) =>
  SYNONYMS.reduce(
    (t, [pattern, word]) => t.replace(pattern, word),
    s.toLowerCase()
  );

/** Free text that names the same thing ("6061-T6" vs "AL6061-T6 bar 2in"). */
export const sameThing = (expected: string | null, read: string | null) => {
  if (!expected) {
    return null;
  }
  if (!read) {
    return false;
  }
  const a = norm(expected);
  const b = norm(read);
  if (a.includes(b) || b.includes(a)) {
    return true;
  }
  const want = canonical(expected);
  const got = canonical(read);
  // Grades decide it when the shop wrote one: 316 is never 304.
  const grades = want.match(GRADE) ?? [];
  if (grades.length) {
    const found = new Set(got.match(GRADE) ?? []);
    if (!grades.every((g) => found.has(g))) {
      return false;
    }
  }
  const wantWords = words(want);
  const gotWords = words(got);
  const shared = [...wantWords].filter((w) => gotWords.has(w)).length;
  return shared / wantWords.size >= 0.6;
};

export const compareLine = (
  expected: ExpectedLine,
  drafted: DraftedLine[]
): LineResult => {
  const line =
    drafted.find(
      (d) =>
        norm(d.partNo) === norm(expected.partNo) &&
        (!expected.rev || norm(d.rev) === norm(expected.rev))
    ) ?? drafted.find((d) => norm(d.partNo) === norm(expected.partNo));
  const breaks = expected.breaks.map((sent): BreakResult => {
    const draft = line?.breaks.find((b) => b.qty === sent.qty);
    const price = draft?.unitPrice ?? null;
    const lead = draft?.leadTimeDays ?? null;
    const priceDiff = price === null ? null : price / sent.unitPrice - 1;
    const leadDiff =
      lead === null || sent.leadTimeDays === null
        ? null
        : lead - sent.leadTimeDays;
    return {
      qty: sent.qty,
      sentUnitPrice: sent.unitPrice,
      draftUnitPrice: price,
      priceDiff,
      priceOk: priceDiff !== null && Math.abs(priceDiff) <= SMALL_PRICE_EDIT,
      sentLeadTimeDays: sent.leadTimeDays,
      draftLeadTimeDays: lead,
      leadTimeDiffDays: leadDiff,
      leadTimeOk:
        sent.leadTimeDays === null
          ? null
          : leadDiff !== null &&
            Math.abs(leadDiff) <= SMALL_LEAD_TIME_EDIT_DAYS,
    };
  });
  return {
    partNo: expected.partNo,
    found: Boolean(line),
    revOk: expected.rev ? norm(line?.rev) === norm(expected.rev) : null,
    qtysOk: expected.breaks.every((b) => line?.qtys.includes(b.qty)),
    // Not found reads as wrong for anything the shop wrote down.
    materialOk: sameThing(expected.material, line?.material ?? null),
    finishOk: sameThing(expected.finish, line?.finish ?? null),
    breaks,
  };
};

export interface FeasibilityResult {
  /** Takumo and the planner gave the same yes/no. */
  agrees: boolean | null;
  /** The case is old enough that the shop's data has moved on since. */
  historical: boolean;
  id: string;
  takumoAnswer: "yes" | "no" | null;
  takumoDate: string | null;
  /** Takumo's date minus what actually happened, in days. */
  vsActualDays: number | null;
  /** Takumo's date minus the planner's, in days. */
  vsPlannerDays: number | null;
}

const days = (a: string, b: string) =>
  Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);

/** Older than this, the schedule Takumo sees isn't the one the planner saw. */
export const HISTORICAL_AFTER_DAYS = 3;

export const compareFeasibility = (
  c: FeasibilityCase,
  takumo: { canTake: boolean; date: string | null } | null,
  today: string
): FeasibilityResult => {
  let answer: "yes" | "no" | null = null;
  if (takumo) {
    answer = takumo.canTake ? "yes" : "no";
  }
  return {
    id: c.id,
    historical: days(today, c.askedDate) > HISTORICAL_AFTER_DAYS,
    takumoAnswer: answer,
    takumoDate: takumo?.date ?? null,
    agrees: answer === null ? null : answer === c.plannerAnswer,
    vsPlannerDays:
      takumo?.date && c.plannerDate ? days(takumo.date, c.plannerDate) : null,
    vsActualDays:
      takumo?.date && c.actualShipDate
        ? days(takumo.date, c.actualShipDate)
        : null,
  };
};

const share = (values: (boolean | null)[]) => {
  const known = values.filter((v): v is boolean => v !== null);
  return { n: known.filter(Boolean).length, of: known.length };
};

const median = (values: number[]) => {
  if (values.length === 0) {
    return null;
  }
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** The numbers the plan's acceptance criteria are written in. */
export const summarize = (
  lines: LineResult[],
  feasibility: FeasibilityResult[]
) => {
  const breaks = lines.flatMap((l) => l.breaks);
  const priced = breaks.filter((b) => b.priceDiff !== null);
  return {
    quotes: {
      linesFound: share(lines.map((l) => l.found)),
      revRead: share(lines.map((l) => l.revOk)),
      qtysRead: share(lines.map((l) => l.qtysOk)),
      materialRead: share(lines.map((l) => l.materialOk)),
      finishRead: share(lines.map((l) => l.finishOk)),
      priced: { n: priced.length, of: breaks.length },
      priceWithin5pct: share(breaks.map((b) => b.priceOk)),
      leadTimeWithin2Days: share(breaks.map((b) => b.leadTimeOk)),
      medianAbsPriceDiff: median(
        priced.map((b) => Math.abs(b.priceDiff as number))
      ),
    },
    feasibility: {
      agrees: share(feasibility.map((f) => f.agrees)),
      historical: feasibility.filter((f) => f.historical).length,
      medianDaysVsPlanner: median(
        feasibility.flatMap((f) =>
          f.vsPlannerDays === null ? [] : [f.vsPlannerDays]
        )
      ),
      medianDaysVsActual: median(
        feasibility.flatMap((f) =>
          f.vsActualDays === null ? [] : [f.vsActualDays]
        )
      ),
    },
  };
};
