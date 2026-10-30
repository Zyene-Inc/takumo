import type { Cell, SheetRow } from "@repo/ingest";
import Papa from "papaparse";
import readXlsxFile from "read-excel-file/browser";

export interface Sheet {
  // Spreadsheet row number of rows[0], so problems point at the right row.
  readonly firstRow: number;
  readonly headers: string[];
  readonly name: string;
  readonly rows: SheetRow[];
}

export const ACCEPTED_FILES = ".csv,.xlsx,.txt,.tsv";

const filled = (row: readonly Cell[]) =>
  row.filter((c) => c !== null && c !== undefined && String(c).trim() !== "")
    .length;

// ERP exports often put a title or report date above the real header row.
// Use the first row (within the first 10) that is about as wide as the data.
const findHeaderRow = (matrix: readonly (readonly Cell[])[]) => {
  const top = matrix.slice(0, 10);
  const widest = Math.max(0, ...top.map(filled));
  const index = top.findIndex(
    (row) => filled(row) >= Math.max(2, widest * 0.6)
  );
  return Math.max(index, 0);
};

const headerText = (cell: Cell, index: number) => {
  const text =
    cell instanceof Date
      ? cell.toISOString().slice(0, 10)
      : String(cell ?? "").trim();
  return text || `Column ${index + 1}`;
};

export const toSheet = (
  name: string,
  matrix: readonly (readonly Cell[])[]
): Sheet => {
  const headerIndex = findHeaderRow(matrix);
  const seen = new Map<string, number>();
  const headers = (matrix[headerIndex] ?? []).map((cell, i) => {
    const base = headerText(cell, i);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
  const rows = matrix
    .slice(headerIndex + 1)
    .map((row) =>
      Object.fromEntries(headers.map((h, i) => [h, row[i] ?? null]))
    );
  // Drop trailing empty rows that spreadsheets often carry.
  while (rows.length > 0 && filled(Object.values(rows.at(-1) ?? {})) === 0) {
    rows.pop();
  }
  return { name, headers, rows, firstRow: headerIndex + 2 };
};

const readCsv = (file: File) =>
  new Promise<Sheet[]>((resolve, reject) => {
    Papa.parse<string[]>(file, {
      // Keep blank lines so row numbers match what the user sees in Excel.
      skipEmptyLines: false,
      complete: (result) => resolve([toSheet(file.name, result.data)]),
      error: reject,
    });
  });

/** Reads every sheet of a CSV or XLSX file in the browser. */
export const readWorkbook = async (file: File): Promise<Sheet[]> => {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xls")) {
    throw new Error(
      "Old .xls files aren't supported. In Excel, use File → Save As → .xlsx or .csv, then upload again."
    );
  }
  if (name.endsWith(".xlsx")) {
    const sheets = await readXlsxFile(file);
    return sheets
      .map((s) => toSheet(s.sheet, s.data as unknown as Cell[][]))
      .filter((s) => s.rows.length > 0);
  }
  return readCsv(file);
};
