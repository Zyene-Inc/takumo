// What a fact can be about, and the values it can hold. Pure (no server
// code), shared by the server, the agent and the review screens.
//
// A fact about a model parameter (setup time, rate, efficiency, cost, lead
// time) changes that record when a supervisor approves it. A "note" is
// knowledge in words ("P-2001 chatters above 1,200 rpm") that Ask Takumo can
// find and cite but that changes no number.

export const SUBJECT_TYPES = [
  "routing",
  "work_center",
  "part",
  "material",
  "customer",
  "shop",
] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export const SUBJECT_LABEL: Record<SubjectType, string> = {
  routing: "Operation",
  work_center: "Machine",
  part: "Part",
  material: "Material",
  customer: "Customer",
  shop: "Shop",
};

export interface AttributeDef {
  /** Decimal places shown. */
  digits?: number;
  key: string;
  kind: "number" | "machine" | "text";
  label: string;
  max?: number;
  min?: number;
  /** Stored as a fraction, shown as a percentage. */
  percent?: boolean;
  /** Shown after the value, e.g. "min". */
  unit?: string;
}

const NOTE: AttributeDef = { key: "note", label: "Note", kind: "text" };

export const ATTRIBUTES: Record<SubjectType, AttributeDef[]> = {
  routing: [
    {
      key: "setupMin",
      label: "Setup time",
      kind: "number",
      unit: "min",
      min: 0,
      max: 10_000,
      digits: 1,
    },
    {
      key: "runMinPerUnit",
      label: "Run time per part",
      kind: "number",
      unit: "min",
      min: 0,
      max: 10_000,
      digits: 2,
    },
    { key: "workCenter", label: "Machine", kind: "machine" },
    NOTE,
  ],
  work_center: [
    {
      key: "hourlyRate",
      label: "Hourly rate",
      kind: "number",
      unit: "$/h",
      min: 0,
      max: 10_000,
      digits: 2,
    },
    {
      key: "efficiency",
      label: "Efficiency",
      kind: "number",
      percent: true,
      min: 0.05,
      max: 1.5,
      digits: 0,
    },
    {
      key: "hoursPerDay",
      label: "Hours per day",
      kind: "number",
      unit: "h",
      min: 0,
      max: 24,
      digits: 1,
    },
    NOTE,
  ],
  material: [
    {
      key: "unitCost",
      label: "Unit cost",
      kind: "number",
      unit: "$",
      min: 0,
      max: 1_000_000,
      digits: 2,
    },
    {
      key: "leadTimeDays",
      label: "Lead time",
      kind: "number",
      unit: "days",
      min: 0,
      max: 365,
      digits: 0,
    },
    NOTE,
  ],
  customer: [
    {
      key: "paymentTermDays",
      label: "Payment terms",
      kind: "number",
      unit: "days",
      min: 0,
      max: 365,
      digits: 0,
    },
    NOTE,
  ],
  part: [NOTE],
  shop: [NOTE],
};

export const attributeDef = (subjectType: string, attribute: string) =>
  ATTRIBUTES[subjectType as SubjectType]?.find((a) => a.key === attribute) ??
  null;

/** Facts that change a number or setting when approved (not notes). */
export const changesModel = (attribute: string) => attribute !== "note";

export const factLabel = (number: number) => `F-${number}`;

const FACT_NO = /^F-?(\d+)$/i;
export const parseFactLabel = (label: string) => {
  const match = label.trim().match(FACT_NO);
  return match ? Number(match[1]) : null;
};

export type FactValue = number | string;

type Parsed = { ok: true; value: FactValue } | { ok: false; error: string };

const MAX_TEXT = 2000;
const NUMBER_NOISE = /[$,%\s]/g;

const parseText = (def: AttributeDef, raw: unknown): Parsed => {
  const text = String(raw ?? "").trim();
  if (!text) {
    return { ok: false, error: `${def.label} can't be empty.` };
  }
  return text.length > MAX_TEXT
    ? { ok: false, error: "Keep it under 2,000 characters." }
    : { ok: true, value: text };
};

const toNumber = (def: AttributeDef, raw: unknown) => {
  if (String(raw ?? "").trim() === "") {
    return Number.NaN;
  }
  const n =
    typeof raw === "number"
      ? raw
      : Number(String(raw).replace(NUMBER_NOISE, ""));
  // "92" for an efficiency means 92%.
  return def.percent && n > (def.max ?? 1.5) ? n / 100 : n;
};

const inRange = (def: AttributeDef, n: number) =>
  (def.min === undefined || n >= def.min) &&
  (def.max === undefined || n <= def.max);

/**
 * Check a value for an attribute. Numbers come in as typed ("120", "92%"
 * for a percentage); text is trimmed. Returns the value to store.
 */
export const parseValue = (def: AttributeDef, raw: unknown): Parsed => {
  if (def.kind !== "number") {
    return parseText(def, raw);
  }
  const n = toNumber(def, raw);
  if (!Number.isFinite(n)) {
    return { ok: false, error: `${def.label} must be a number.` };
  }
  if (!inRange(def, n)) {
    return {
      ok: false,
      error: `${def.label} must be between ${formatValue(def, def.min ?? 0)} and ${formatValue(def, def.max ?? 0)}.`,
    };
  }
  const f = 10 ** ((def.digits ?? 2) + (def.percent ? 2 : 0));
  return { ok: true, value: Math.round(n * f) / f };
};

export const formatValue = (def: AttributeDef | null, value: unknown) => {
  if (value === null || value === undefined) {
    return "—";
  }
  if (!def || def.kind !== "number" || typeof value !== "number") {
    return String(value);
  }
  if (def.percent) {
    return `${Math.round(value * 100)}%`;
  }
  const n = value.toLocaleString("en-US", {
    maximumFractionDigits: def.digits ?? 2,
  });
  if (def.unit === "$") {
    return `$${n}`;
  }
  if (def.unit === "$/h") {
    return `$${n}/h`;
  }
  return def.unit ? `${n} ${def.unit}` : n;
};
