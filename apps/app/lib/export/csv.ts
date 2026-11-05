// Shop data as CSV files with the import templates' headers, so an export can
// be loaded straight back into Takumo (or anywhere else). Pure, so tested.

import { ENTITIES, type EntityKey } from "@repo/ingest";
import { strToU8, zipSync } from "fflate";
import Papa from "papaparse";

type Cell = string | number | boolean | null | undefined;
type Row = Record<string, Cell>;

/** Rows keyed by import field (partNo, setupMin…) → CSV with the template's labels. */
export const entityCsv = (entity: EntityKey, rows: Row[]) => {
  const fields = ENTITIES[entity].fields;
  return Papa.unparse({
    fields: fields.map((f) => f.label),
    data: rows.map((row) => fields.map((f) => row[f.key] ?? "")),
  });
};

/** Free-form CSV (facts, notes, RFQs) from rows with their own columns. */
export const plainCsv = (columns: string[], rows: Row[]) =>
  Papa.unparse({
    fields: columns,
    data: rows.map((row) => columns.map((c) => row[c] ?? "")),
  });

/** A zip of text files. */
export const zipFiles = (files: Record<string, string>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, strToU8(text)])
    ),
    { level: 6 }
  );
