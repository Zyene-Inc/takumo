// Matches what a customer wrote on an RFQ to the shop's own records. Pure.
// The model suggests matches from the shop's lists; these checks decide.

const COMPANY_SUFFIX =
  /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|plc)\b\.?/g;
const NOT_ALNUM = /[^a-z0-9]+/g;
const LETTER_DIGIT = /([a-z])(\d)|(\d)([a-z])/g;

/** "Bluefin Marine, Inc." → "bluefin marine" */
export const normalizeName = (name: string) =>
  name
    .toLowerCase()
    .replace(COMPANY_SUFFIX, " ")
    .replace(NOT_ALNUM, " ")
    .trim()
    .replace(/\s+/g, " ");

/** "p 1001", "P-1001", "p1001" → "p1001" */
export const normalizePartNo = (partNo: string) =>
  partNo.toLowerCase().replace(NOT_ALNUM, "");

const tokens = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .replace(LETTER_DIGIT, "$1$3 $2$4")
      .split(NOT_ALNUM)
      .filter(Boolean)
  );

export interface Named {
  id: string;
  name: string;
}

/** A customer by name: exact after dropping "Inc." and punctuation, or one contains the other. */
export const matchCustomer = <T extends Named>(
  written: string | null | undefined,
  customers: readonly T[]
): T | null => {
  if (!written) {
    return null;
  }
  const want = normalizeName(written);
  if (!want) {
    return null;
  }
  const exact = customers.find((c) => normalizeName(c.name) === want);
  if (exact) {
    return exact;
  }
  const containing = customers.filter((c) => {
    const have = normalizeName(c.name);
    return (
      have.length >= 4 &&
      (want.startsWith(`${have} `) || have.startsWith(`${want} `))
    );
  });
  return containing.length === 1 ? containing[0] : null;
};

export interface PartLike {
  id: string;
  partNo: string;
  rev: string;
}

export interface PartMatch<T> {
  /** The same part number at another revision (a starting point for a new rev). */
  otherRev: T | null;
  /** The part this line is for, when the shop has that part and revision. */
  part: T | null;
}

/** Revisions sort A < B < … < Z < AA; numbers numerically. */
const revOrder = (a: string, b: string) =>
  a.length - b.length || a.localeCompare(b, undefined, { numeric: true });

export const matchPart = <T extends PartLike>(
  partNo: string | null | undefined,
  rev: string | null | undefined,
  parts: readonly T[]
): PartMatch<T> => {
  if (!partNo) {
    return { part: null, otherRev: null };
  }
  const want = normalizePartNo(partNo);
  const same = parts
    .filter((p) => normalizePartNo(p.partNo) === want)
    .sort((a, b) => revOrder(b.rev, a.rev));
  if (same.length === 0) {
    return { part: null, otherRev: null };
  }
  if (!rev) {
    return { part: same[0], otherRev: null };
  }
  const exact = same.find(
    (p) => p.rev.trim().toLowerCase() === rev.trim().toLowerCase()
  );
  return exact
    ? { part: exact, otherRev: null }
    : { part: null, otherRev: same[0] };
};

const ALLOY = /^\d{3,4}$/;

/**
 * A material by what the customer wrote ("6061-T6 aluminum, 2 in bar"). The
 * alloy number has to agree; then the closest by shared words wins.
 */
export const matchMaterial = <T extends Named>(
  written: string | null | undefined,
  materials: readonly T[]
): T | null => {
  if (!written) {
    return null;
  }
  const want = tokens(written);
  const wantAlloys = [...want].filter((t) => ALLOY.test(t));
  let best: T | null = null;
  let bestScore = 0;
  for (const material of materials) {
    const have = tokens(material.name);
    if (normalizeName(material.name) === normalizeName(written)) {
      return material;
    }
    const haveAlloys = [...have].filter((t) => ALLOY.test(t));
    if (
      wantAlloys.length &&
      haveAlloys.length &&
      !wantAlloys.some((a) => haveAlloys.includes(a))
    ) {
      continue;
    }
    const shared = [...want].filter((t) => have.has(t));
    const score =
      shared.filter((t) => ALLOY.test(t)).length * 3 + shared.length;
    if (score > bestScore) {
      best = material;
      bestScore = score;
    }
  }
  return bestScore >= 3 ? best : null;
};

/** Shop part numbers that appear in the RFQ text (to show the model). */
export const partsMentioned = <T extends PartLike>(
  text: string,
  parts: readonly T[]
): T[] => {
  const haystack = normalizePartNo(text);
  return parts.filter((p) => {
    const needle = normalizePartNo(p.partNo);
    return needle.length >= 3 && haystack.includes(needle);
  });
};
