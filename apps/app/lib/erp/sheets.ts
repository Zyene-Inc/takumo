// ERP reports arrive as email attachments: read them on the server the same
// way the import page reads uploads, and recognise a recurring report by its
// header row. Pure, so tested.

import { createHash } from "node:crypto";
import type { Cell } from "@repo/ingest";
import Papa from "papaparse";
import { read, utils } from "xlsx";
import {
  type Sheet,
  toSheet,
} from "@/app/(authenticated)/onboarding/read-file";

const REPORT_TYPES = [".csv", ".tsv", ".txt", ".xlsx", ".xls", ".xlsm", ".ods"];
const SPREADSHEET = /\.(xlsx|xlsm|xls|ods)$/;
const NOT_WORD = /[^a-z0-9]+/g;

const pad = (n: number) => String(n).padStart(2, "0");
// The server runs in UTC, so a date cell's calendar day is its UTC day.
const calendarDate = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export const isReport = (fileName: string) =>
  REPORT_TYPES.some((ext) => fileName.toLowerCase().endsWith(ext));

/** Every non-empty sheet of a CSV or Excel attachment. */
export const readSheets = (fileName: string, bytes: Uint8Array): Sheet[] => {
  if (SPREADSHEET.test(fileName.toLowerCase())) {
    const book = read(bytes, { type: "array", cellDates: true, dense: true });
    return book.SheetNames.map((name) => {
      const matrix = utils.sheet_to_json<Cell[]>(book.Sheets[name], {
        header: 1,
        raw: true,
        defval: null,
        blankrows: true,
      });
      return toSheet(
        book.SheetNames.length > 1 ? `${fileName} › ${name}` : fileName,
        matrix.map((row) =>
          row.map((cell) => (cell instanceof Date ? calendarDate(cell) : cell))
        )
      );
    }).filter((s) => s.rows.length > 0);
  }
  const text = new TextDecoder().decode(bytes);
  const { data } = Papa.parse<string[]>(text, { skipEmptyLines: false });
  const sheet = toSheet(fileName, data);
  return sheet.rows.length > 0 ? [sheet] : [];
};

/**
 * The same report every night has the same columns, whatever the file is
 * called and whatever order the ERP lists them in.
 */
export const headerKey = (headers: string[]) =>
  createHash("sha256")
    .update(
      headers
        .map((h) => h.toLowerCase().replace(NOT_WORD, " ").trim())
        .filter(Boolean)
        .sort()
        .join("|")
    )
    .digest("hex")
    .slice(0, 32);

/** A sheet's content, to tell a resent report from a new one. */
export const sheetHash = (sheet: { headers: string[]; rows: unknown[] }) =>
  createHash("sha256")
    .update(JSON.stringify([sheet.headers, sheet.rows]))
    .digest("hex")
    .slice(0, 32);
