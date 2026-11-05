import { ENTITIES, type FieldDef } from "./entities";
import type { ColumnMapping } from "./match";

// A cell as it comes out of the CSV or XLSX reader.
export type Cell = string | number | boolean | Date | null | undefined;
export type SheetRow = Readonly<Record<string, Cell>>;

export type Value = string | number | string[] | null;

export interface ParsedRecord {
  // 1-based spreadsheet row number, as the user sees it in Excel.
  readonly row: number;
  readonly values: Readonly<Record<string, Value>>;
}

export interface RowError {
  readonly field: string;
  readonly message: string;
  readonly row: number;
  // "error": the row is skipped. "warning": the row is kept without this value.
  readonly severity: "error" | "warning";
}

export interface ParseResult {
  // Rows that were entirely empty and ignored.
  readonly blankRows: number;
  readonly errors: RowError[];
  readonly records: ParsedRecord[];
}

const isBlank = (cell: Cell) =>
  cell === null ||
  cell === undefined ||
  (typeof cell === "string" && cell.trim() === "");

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
const US_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/;
const DAY_MONTH_YEAR = /^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s-](\d{2,4})$/;
const MONTH_DAY_YEAR = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/;
const PARENTHESES = /^\(.*\)$/;
const NUMBER_NOISE = /[$,\s]/g;
const FIRST_NUMBER = /-?\d+(\.\d+)?|-?\.\d+/;
const LIST_SEPARATOR = /[|,;]/;

// Excel stores dates as days since 1899-12-30.
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

const toIsoDate = (date: Date) => date.toISOString().slice(0, 10);

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

const fullYear = (year: number) => (year < 100 ? 2000 + year : year);

const validDate = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? toIsoDate(date)
    : null;
};

export const parseDate = (cell: Cell): string | null => {
  if (cell instanceof Date) {
    return Number.isNaN(cell.getTime()) ? null : toIsoDate(cell);
  }
  if (typeof cell === "number") {
    // Plausible Excel serials: 1954–2119.
    return cell > 20_000 && cell < 80_000
      ? toIsoDate(new Date(EXCEL_EPOCH + Math.round(cell) * DAY_MS))
      : null;
  }
  const text = String(cell).trim();
  let m = text.match(ISO_DATE);
  if (m) {
    return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  // US shops: month/day/year.
  m = text.match(US_DATE);
  if (m) {
    return validDate(fullYear(Number(m[3])), Number(m[1]), Number(m[2]));
  }
  // 13-Nov-2026, 13 Nov 2026
  m = text.match(DAY_MONTH_YEAR);
  if (m) {
    const month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    return month
      ? validDate(fullYear(Number(m[3])), month, Number(m[1]))
      : null;
  }
  // Nov 13, 2026
  m = text.match(MONTH_DAY_YEAR);
  if (m) {
    const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    return month ? validDate(Number(m[3]), month, Number(m[2])) : null;
  }
  return null;
};

/** "$1,234.50" → 1234.5, "12%" → 0.12, "Net 30" → 30, "(50)" → -50. */
export const parseNumber = (cell: Cell): number | null => {
  if (typeof cell === "number") {
    return Number.isFinite(cell) ? cell : null;
  }
  if (typeof cell === "boolean" || cell instanceof Date) {
    return null;
  }
  const text = String(cell).trim();
  const negative = PARENTHESES.test(text);
  const m = text.replace(NUMBER_NOISE, "").match(FIRST_NUMBER);
  if (!m) {
    return null;
  }
  let value = Number(m[0]);
  if (text.endsWith("%")) {
    value /= 100;
  }
  return negative ? -Math.abs(value) : value;
};

const parseEnum = (field: FieldDef, cell: Cell) => {
  const text = String(cell)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, " ");
  const underscored = text.replace(/ /g, "_");
  if (field.values?.includes(underscored)) {
    return underscored;
  }
  return field.valueAliases?.[text] ?? null;
};

const parseCell = (
  field: FieldDef,
  cell: Cell,
  hours: boolean
): { value: Value } | { error: string } => {
  switch (field.kind) {
    case "text":
      return {
        value: cell instanceof Date ? toIsoDate(cell) : String(cell).trim(),
      };
    case "number": {
      const n = parseNumber(cell);
      return n === null ? { error: `"${cell}" is not a number` } : { value: n };
    }
    case "integer": {
      const n = parseNumber(cell);
      if (n === null) {
        return { error: `"${cell}" is not a number` };
      }
      return field.positive && Math.round(n) <= 0
        ? { error: `"${cell}" must be at least 1` }
        : { value: Math.round(n) };
    }
    case "minutes": {
      const n = parseNumber(cell);
      if (n === null) {
        return { error: `"${cell}" is not a time` };
      }
      return { value: Number((hours ? n * 60 : n).toFixed(4)) };
    }
    case "date": {
      const d = parseDate(cell);
      return d === null ? { error: `"${cell}" is not a date` } : { value: d };
    }
    case "list":
      return {
        value: String(cell)
          .split(LIST_SEPARATOR)
          .map((s) => s.trim())
          .filter(Boolean),
      };
    case "enum": {
      const v = parseEnum(field, cell);
      return v === null
        ? {
            error: `"${cell}" is not one of ${field.values?.join(", ")}`,
          }
        : { value: v };
    }
    default:
      return { error: "Unknown field type" };
  }
};

/**
 * One field of one row: its value, or null with the problem added to
 * `errors`. `ok` is false when a required value is missing or unreadable.
 */
const readField = (
  field: FieldDef,
  cell: Cell | undefined,
  inHours: boolean,
  rowNumber: number,
  errors: RowError[]
): { ok: boolean; value: Value } => {
  if (isBlank(cell)) {
    if (field.required) {
      errors.push({
        row: rowNumber,
        field: field.label,
        message: "Missing value",
        severity: "error",
      });
    }
    return { ok: !field.required, value: null };
  }
  const parsed = parseCell(field, cell, inHours);
  if ("error" in parsed) {
    errors.push({
      row: rowNumber,
      field: field.label,
      message: parsed.error,
      severity: field.required ? "error" : "warning",
    });
    return { ok: !field.required, value: null };
  }
  return { ok: true, value: parsed.value };
};

/**
 * Turns sheet rows into typed records using the confirmed mapping.
 * Rows missing a required value, or with a value that can't be read, are
 * reported in `errors` and left out of `records`.
 */
export const parseRows = (
  rows: readonly SheetRow[],
  mapping: ColumnMapping,
  // Spreadsheet row number of rows[0]; 2 when the header is the first row.
  firstRow = 2
): ParseResult => {
  const fields = ENTITIES[mapping.entity].fields;
  const records: ParsedRecord[] = [];
  const errors: RowError[] = [];
  let blankRows = 0;

  rows.forEach((row, index) => {
    const rowNumber = index + firstRow;
    if (Object.values(row).every(isBlank)) {
      blankRows += 1;
      return;
    }
    const values: Record<string, Value> = {};
    let ok = true;
    for (const field of fields) {
      const column = mapping.columns[field.key];
      const read = readField(
        field,
        column ? row[column] : undefined,
        mapping.timeUnits[field.key] === "hours",
        rowNumber,
        errors
      );
      values[field.key] = read.value;
      ok &&= read.ok;
    }
    if (ok) {
      records.push({ row: rowNumber, values });
    }
  });

  return { records, errors, blankRows };
};
