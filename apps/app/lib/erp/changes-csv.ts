// "Changes to make in your ERP" as a file (docs/PRODUCT-PLAN.md F1.4-R3):
// one row per approved change, to work through in the ERP or hand to
// whoever keeps it. Pure, so tested.

import { csvCell } from "../orders/erp";
import type { ErpChange } from "./changes";

const COLUMNS = [
  "Fact",
  "Record type",
  "Record",
  "Field",
  "In your ERP now",
  "Change it to",
  "Why",
  "Approved",
];

export const changesCsv = (changes: ErpChange[]) =>
  [
    COLUMNS.join(","),
    ...changes.map((c) =>
      [
        c.fact,
        c.kind,
        c.label,
        c.field,
        c.was,
        c.now,
        c.evidence,
        c.reviewedAt.slice(0, 10),
      ]
        .map(csvCell)
        .join(",")
    ),
  ].join("\r\n");

/** "takumo-erp-changes-2026-11-04.csv" */
export const changesFileName = (now: Date) =>
  `takumo-erp-changes-${now.toISOString().slice(0, 10)}.csv`;
