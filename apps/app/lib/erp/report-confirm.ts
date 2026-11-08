import "server-only";

import { database, forOrg } from "@repo/database";
import { type ColumnMapping, ENTITIES, missingRequired } from "@repo/ingest";
import {
  importReportRows,
  type PendingRows,
  type ReportMode,
  type ReportResult,
  UnreadableReportError,
} from "./reports";

/**
 * An admin confirms what a report's columns mean (and whether it lists
 * everything): the waiting rows are imported and later reports run alone.
 */
export const confirmReport = async (
  orgId: string,
  reportId: string,
  mapping: ColumnMapping,
  mode: ReportMode,
  /** The report's columns were renamed: retire the one it replaces. */
  replace = false
): Promise<
  { ok: true; result: ReportResult | null } | { ok: false; error: string }
> => {
  if (!(mapping.entity in ENTITIES)) {
    return { ok: false, error: "Choose what this report contains." };
  }
  const missing = missingRequired(mapping);
  if (missing.length) {
    return { ok: false, error: `Choose a column for: ${missing.join(", ")}.` };
  }
  const db = forOrg(database, orgId);
  const report = await db.erpReport.findFirst({ where: { id: reportId } });
  if (!report) {
    return { ok: false, error: "That report no longer exists." };
  }
  await db.erpReport.updateMany({
    where: { id: report.id },
    data: {
      mapping: mapping as object,
      entity: mapping.entity,
      mode,
      status: "active",
    },
  });
  const pending = report.pending as PendingRows | null;
  const replaced = replace ? pending?.replaces?.report.id : undefined;
  const old = replaced
    ? await db.erpReport.findFirst({
        where: { id: replaced, NOT: { id: report.id } },
        select: { id: true, status: true },
      })
    : null;
  // The old header row won't arrive again: this report takes over. Paused
  // while importing so it's the one full report of its kind; removed once
  // the rows are in (records it imported stay).
  const retire = async () => {
    if (old) {
      await db.erpReport.deleteMany({ where: { id: old.id } });
    }
  };
  if (old) {
    await db.erpReport.updateMany({
      where: { id: old.id },
      data: { status: "paused" },
    });
  }
  if (!pending?.rows?.length) {
    await retire();
    return { ok: true, result: null };
  }
  try {
    const result = await importReportRows(
      orgId,
      { id: report.id, name: report.name, mode },
      mapping,
      pending
    );
    await retire();
    return { ok: true, result };
  } catch (error) {
    if (old) {
      await db.erpReport.updateMany({
        where: { id: old.id },
        data: { status: old.status },
      });
    }
    if (error instanceof UnreadableReportError) {
      // Not confirmed after all: it waits for the right columns.
      await db.erpReport.updateMany({
        where: { id: report.id },
        data: { status: "needs_mapping" },
      });
      return {
        ok: false,
        error:
          "None of the rows could be read with these columns. Check which column holds each value.",
      };
    }
    throw error;
  }
};
