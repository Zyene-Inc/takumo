// The PO laid out ready to enter in the ERP: plain text to read or paste, and
// a CSV many ERPs can import. Pure.

import type { PoLine } from "./types";

export interface ErpPo {
  customer: string | null;
  lines: PoLine[];
  poNo: string | null;
  shipTo: string | null;
  terms: string | null;
}

export const CSV_COLUMNS = [
  "Customer",
  "Customer PO",
  "Line",
  "Part",
  "Rev",
  "Description",
  "Qty",
  "Unit price",
  "Due date",
] as const;

const NEEDS_QUOTES = /[",\r\n]/;
/** A cell a spreadsheet would run as a formula ("=…", "+…", "-…", "@…"). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: quoted when needed, and never read as a formula. */
export const csvCell = (value: string | number | null) => {
  if (value === null) {
    return "";
  }
  let s = String(value);
  if (typeof value === "string" && FORMULA_START.test(s)) {
    s = `'${s}`;
  }
  return NEEDS_QUOTES.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

const price = (n: number | null) => (n === null ? null : n.toFixed(2));

export const poCsv = (po: ErpPo) =>
  [
    CSV_COLUMNS.join(","),
    ...po.lines.map((l) =>
      [
        po.customer,
        po.poNo,
        l.lineNo,
        l.partNo,
        l.rev,
        l.description,
        l.qty,
        price(l.unitPrice),
        l.dueDate,
      ]
        .map(csvCell)
        .join(",")
    ),
  ].join("\r\n");

const money = (n: number | null) =>
  n === null
    ? "—"
    : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The order in plain words, line by line. */
export const poSummary = (po: ErpPo) => {
  const head = [
    `Customer: ${po.customer ?? "—"}`,
    `Customer PO: ${po.poNo ?? "—"}`,
    ...(po.shipTo ? [`Ship to: ${po.shipTo}`] : []),
    ...(po.terms ? [`Terms: ${po.terms}`] : []),
  ];
  const lines = po.lines.map((l) =>
    [
      `${l.lineNo}. ${l.partNo ?? l.description ?? "—"}${l.rev ? ` rev ${l.rev}` : ""}`,
      `qty ${l.qty?.toLocaleString("en-US") ?? "—"}`,
      `${money(l.unitPrice)} each`,
      `due ${l.dueDate ?? "—"}`,
    ].join(", ")
  );
  const total = po.lines.reduce((sum, l) => sum + (l.extended ?? 0), 0);
  return [
    ...head,
    "",
    ...lines,
    "",
    `Total: ${money(Math.round(total * 100) / 100)}`,
  ].join("\n");
};
