// Quote and order numbers, the accepted-draft measure, and the prices an
// estimator starts from. Pure, so tested.

import type { QuoteResponse } from "@repo/engine-client/types";
import type { LineFinal } from "./types";

const TRAILING_NUMBER = /^(.*?)(\d+)$/;
const QTY_SEPARATORS = /[\s,/;]+/;
const WHOLE = /^\d+$/;

/**
 * Quantities as an estimator types them: "50, 100, 250" or "50/100/250".
 * Null unless every piece is a whole number above zero. Duplicates dropped.
 */
export const parseQtys = (value: string) => {
  const pieces = value.trim().split(QTY_SEPARATORS).filter(Boolean);
  if (pieces.length === 0 || !pieces.every((p) => WHOLE.test(p))) {
    return null;
  }
  const qtys = pieces.map(Number);
  return qtys.every((q) => q > 0) ? [...new Set(qtys)] : null;
};

/**
 * The next number in the shop's own series: after Q-9008 comes Q-9009, after
 * SO-5006 comes SO-5007 (zero padding kept). Uses the series most of the
 * existing numbers follow; `fallback` starts one when there's none.
 */
export const nextNumber = (existing: string[], fallback: string) => {
  const series = new Map<
    string,
    { count: number; max: number; width: number }
  >();
  for (const value of existing) {
    const match = value.match(TRAILING_NUMBER);
    if (!match) {
      continue;
    }
    const [, prefix, digits] = match;
    const s = series.get(prefix) ?? { count: 0, max: 0, width: 0 };
    s.count += 1;
    s.max = Math.max(s.max, Number(digits));
    s.width = Math.max(s.width, digits.length);
    series.set(prefix, s);
  }
  const [prefix, s] =
    [...series.entries()].sort((a, b) => b[1].count - a[1].count)[0] ?? [];
  if (prefix === undefined || !s) {
    return fallback;
  }
  const taken = new Set(existing);
  let n = s.max + 1;
  let candidate = `${prefix}${String(n).padStart(s.width, "0")}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${prefix}${String(n).padStart(s.width, "0")}`;
  }
  return candidate;
};

/** A draft counts as accepted when what was sent stays this close to it. */
export const SMALL_PRICE_EDIT = 0.05;
export const SMALL_LEAD_TIME_EDIT_DAYS = 2;
/** Phase 4 is done when estimators accept this share of drafts. */
export const ACCEPTANCE_TARGET = 0.7;

export interface DraftedQuote {
  draftLeadTimeDays: number | null;
  draftPrice: number | null;
  leadTimeDays: number | null;
  price: number | null;
}

export const acceptedWithSmallEdits = (q: DraftedQuote) => {
  if (q.draftPrice === null || q.price === null || q.draftPrice <= 0) {
    return false;
  }
  const priceOk =
    Math.abs(q.price - q.draftPrice) / q.draftPrice <= SMALL_PRICE_EDIT + 1e-9;
  const leadOk =
    q.draftLeadTimeDays === null ||
    q.leadTimeDays === null ||
    Math.abs(q.leadTimeDays - q.draftLeadTimeDays) <= SMALL_LEAD_TIME_EDIT_DAYS;
  return priceOk && leadOk;
};

export const acceptance = (quotes: DraftedQuote[]) => {
  const drafted = quotes.filter((q) => q.draftPrice !== null);
  const accepted = drafted.filter(acceptedWithSmallEdits).length;
  return {
    drafted: drafted.length,
    accepted,
    rate: drafted.length ? accepted / drafted.length : null,
  };
};

/**
 * What an estimator starts from: the draft's unit price and lead time at
 * each quantity (null when the draft couldn't price every quantity).
 */
export const startingFinal = (response: QuoteResponse): LineFinal | null => {
  if (response.breaks.some((b) => b.unit_price === null)) {
    return null;
  }
  return {
    breaks: response.breaks.map((b) => ({
      qty: b.qty,
      unitPrice: b.unit_price ?? 0,
      leadTimeDays: b.lead_time_days ?? 0,
    })),
  };
};
