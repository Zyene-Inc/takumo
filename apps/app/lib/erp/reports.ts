import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import {
  type ColumnMapping,
  ENTITIES,
  type EntityKey,
  parseRows,
} from "@repo/ingest";
import { suggestMappingWithAi } from "@repo/ingest/ai-mapping";
import { saveRecords } from "@repo/ingest/save";
import { log } from "@repo/observability/log";
import type { Sheet } from "@/app/(authenticated)/onboarding/read-file";
import { budgetProblem, recordUsage } from "../ai-usage";
import { markEnteredFromErp } from "../orders/settle";
import { settleFromErp } from "../quotes/settle";
import { findRenamed, type Renamed } from "./renamed";
import { confirmedReports, isResend } from "./report-resend";
import { headerKey, sheetHash } from "./sheets";

// A shop's ERP emails the same reports every night (docs/PRODUCT-PLAN.md
// F1.3). The first time a report arrives Takumo suggests what its columns
// mean and an admin confirms; from then on it imports with no one involved.

/** Rows kept from an unconfirmed report until its columns are confirmed. */
const MAX_PENDING_ROWS = 20_000;
/**
 * The same file again within this long is a resend, not new data (F1.3: a
 * duplicate report the same day is a no-op). Hours rather than the calendar
 * day, so a resend just after midnight is still caught.
 */
export const DUPLICATE_WITHIN_MS = 20 * 3_600_000;
export const REPORT_MODES = ["full", "changes"] as const;
export type ReportMode = (typeof REPORT_MODES)[number];

export interface ReportResult {
  /** Records the ERP no longer lists (full reports): closed, received, zeroed. */
  closed: number;
  created: number;
  errors: number;
  /** The imported file's content hash, to recognise a resend. */
  fileHash?: string;
  notes: string[];
  skipped: number;
  updated: number;
}

export interface PendingRows {
  fileName: string;
  firstRow: number;
  /** The confirmed report this one replaces (its columns were renamed). */
  replaces?: Replaces;
  rows: Sheet["rows"];
  /** Rows in the file, when more than are kept here (a waiting report). */
  total?: number;
}

export type Replaces = Pick<
  Renamed,
  "added" | "removed" | "renamed" | "report" | "complete"
>;

/** Nothing in the report could be read: a column was renamed or removed. */
export class UnreadableReportError extends Error {}

export type SheetOutcome =
  | { status: "imported"; report: string; result: ReportResult }
  | { status: "duplicate"; report: string }
  | {
      status: "needs_mapping";
      report: string;
      entity: EntityKey;
      reportId?: string;
      /** Set when it's a known report whose columns the ERP renamed. */
      replaces?: Replaces;
    }
  | {
      status: "paused" | "failed";
      report: string;
      error?: string;
      reportId?: string;
    };

/**
 * A full report lists everything that's open: what the ERP used to list and
 * no longer does has been finished, received or used up. Only records the ERP
 * fed (syncedAt set) are touched, never ones typed into Takumo.
 */
const closeMissing = async (
  orgId: string,
  entity: EntityKey,
  syncedAt: Date
) => {
  const db = forOrg(database, orgId);
  const before = { syncedAt: { lt: syncedAt, not: null } };
  if (entity === "orders") {
    const { count } = await db.order.updateMany({
      where: { ...before, status: { in: ["open", "in_progress"] } },
      data: { status: "done" },
    });
    return count;
  }
  if (entity === "purchaseOrders") {
    const { count } = await db.purchaseOrderLine.updateMany({
      where: { ...before, status: { in: ["open", "partial"] } },
      data: { status: "received" },
    });
    return count;
  }
  if (entity === "stock") {
    const { count } = await db.stockLevel.updateMany({
      where: { ...before, qtyOnHand: { gt: 0 } },
      data: { qtyOnHand: 0, qtyAllocated: 0, asOf: syncedAt },
    });
    return count;
  }
  return 0;
};

const CLOSED_WORD: Partial<Record<EntityKey, string>> = {
  orders: "orders no longer open in the ERP marked done",
  purchaseOrders: "purchase-order lines no longer open marked received",
  stock: "materials no longer in stock set to zero",
};

/**
 * Close what a full report no longer lists, only when that's safe: the whole
 * file was kept and read (a half-read report would close records that are
 * still open), and this is the one full report of its kind (two stock
 * reports, two warehouses, would zero each other's rows every night).
 */
const closeIfSafe = async (
  orgId: string,
  mode: string,
  entity: EntityKey,
  syncedAt: Date,
  read: { rowErrors: number; whole: boolean }
): Promise<{ closed: number; notes: string[] }> => {
  if (mode !== "full") {
    return { closed: 0, notes: [] };
  }
  if (read.rowErrors > 0) {
    return {
      closed: 0,
      notes: [
        `${read.rowErrors} rows couldn't be read, so nothing was closed this time`,
      ],
    };
  }
  if (!read.whole) {
    return {
      closed: 0,
      notes: ["Only part of the file was kept, so nothing was closed"],
    };
  }
  const fullReports = await forOrg(database, orgId).erpReport.count({
    where: { status: "active", mode: "full", entity },
  });
  if (fullReports > 1) {
    return {
      closed: 0,
      notes: [
        "Another full report sends the same kind of data, so nothing was closed (each would close the other's rows)",
      ],
    };
  }
  const closed = await closeMissing(orgId, entity, syncedAt);
  return {
    closed,
    notes: closed
      ? [`${closed} ${CLOSED_WORD[entity] ?? "records closed"}`]
      : [],
  };
};

/** Import rows with a confirmed mapping, stamped as coming from the ERP. */
export const importReportRows = async (
  orgId: string,
  report: { id: string; name: string; mode: string },
  mapping: ColumnMapping,
  pending: PendingRows,
  fileHash?: string
): Promise<ReportResult> => {
  const { records, errors } = parseRows(
    pending.rows,
    mapping,
    pending.firstRow
  );
  if (records.length === 0 && errors.some((e) => e.severity === "error")) {
    // Every row failed (e.g. the ERP renamed a column): import nothing, close
    // nothing, and leave lastImportAt alone so the report shows as late.
    throw new UnreadableReportError(
      `None of the ${pending.rows.length} rows could be read with the saved columns. A column may have been renamed in your ERP: check this report's columns.`
    );
  }
  const syncedAt = new Date();
  const db = forOrg(database, orgId);
  const source = await db.source.create({
    data: {
      orgId,
      name: `${report.name} (ERP report)`,
      type: "erp",
      profile: mapping.entity,
      status: "parsing",
    },
  });
  const saved = await saveRecords(database, orgId, mapping.entity, records, {
    sourceId: source.id,
    syncedAt,
  });
  const rowErrors = new Set(
    errors.filter((e) => e.severity === "error").map((e) => e.row)
  ).size;
  const { closed, notes: closeNotes } = await closeIfSafe(
    orgId,
    report.mode,
    mapping.entity,
    syncedAt,
    {
      rowErrors,
      whole: (pending.total ?? pending.rows.length) <= pending.rows.length,
    }
  );
  const notes = [...saved.notes, ...closeNotes];
  const result: ReportResult = {
    created: saved.created,
    updated: saved.updated,
    skipped: saved.skipped + rowErrors,
    errors: rowErrors,
    closed,
    notes,
    ...(fileHash ? { fileHash } : {}),
  };
  if (mapping.entity === "orders") {
    // New orders may answer open quotes (won within 60 days).
    const settled = await settleFromErp(orgId);
    if (settled.won || settled.lost) {
      result.notes.push(
        `${settled.won} quote${settled.won === 1 ? "" : "s"} marked won and ${settled.lost} lost from these orders`
      );
    }
    // Customer POs someone entered in the ERP are now in these orders.
    const entered = await markEnteredFromErp(orgId);
    if (entered) {
      result.notes.push(
        `${entered} customer PO${entered === 1 ? "" : "s"} now in your ERP`
      );
    }
  }
  const label = ENTITIES[mapping.entity].label.toLowerCase();
  await db.source.updateMany({
    where: { id: source.id },
    data: {
      status: "ready",
      summary: `${label}: ${result.created} added, ${result.updated} updated, ${result.skipped} skipped${closed ? `, ${closed} closed` : ""}`,
    },
  });
  await db.erpReport.updateMany({
    where: { id: report.id },
    data: {
      lastImportAt: syncedAt,
      lastResult: result as object,
      pending: Prisma.DbNull,
    },
  });
  return result;
};

/** What a new report's columns probably mean (AI when the shop has budget). */
const suggest = async (orgId: string, sheet: Sheet) =>
  suggestMappingWithAi({
    fileName: sheet.name,
    headers: sheet.headers,
    rows: sheet.rows,
    useAi: !(await budgetProblem(orgId)),
    onUsage: (modelId, usage) =>
      recordUsage(orgId, "import_mapping", modelId, usage),
  });

/** One sheet of an emailed report: import it, or keep it for mapping. */
export const handleReportSheet = async (
  orgId: string,
  sheet: Sheet
): Promise<SheetOutcome> => {
  const db = forOrg(database, orgId);
  const key = headerKey(sheet.headers);
  const now = new Date();
  // Kept while waiting for an admin: capped. A confirmed report imports
  // every row (below).
  const pending: PendingRows = {
    fileName: sheet.name,
    firstRow: sheet.firstRow,
    rows: sheet.rows.slice(0, MAX_PENDING_ROWS),
    total: sheet.rows.length,
  };
  const existing = await db.erpReport.findFirst({ where: { headerKey: key } });
  if (existing?.status === "paused") {
    await db.erpReport.updateMany({
      where: { id: existing.id },
      data: { lastReceivedAt: now },
    });
    return { status: "paused", report: existing.name };
  }
  if (existing?.status === "active" && existing.mapping) {
    await db.erpReport.updateMany({
      where: { id: existing.id },
      data: { lastReceivedAt: now, name: sheet.name },
    });
    const fileHash = sheetHash(sheet);
    if (isResend(existing, fileHash, now)) {
      return { status: "duplicate", report: sheet.name };
    }
    try {
      const result = await importReportRows(
        orgId,
        existing,
        existing.mapping as unknown as ColumnMapping,
        { fileName: sheet.name, firstRow: sheet.firstRow, rows: sheet.rows },
        fileHash
      );
      return { status: "imported", report: sheet.name, result };
    } catch (error) {
      if (error instanceof UnreadableReportError) {
        return {
          status: "failed",
          report: sheet.name,
          error: error.message,
          reportId: existing.id,
        };
      }
      log.error("ERP report import failed", { orgId, error: String(error) });
      return {
        status: "failed",
        report: sheet.name,
        error: "Saving the rows failed; the next report will try again.",
      };
    }
  }
  // A report the shop confirmed, with columns the ERP renamed: carry its
  // choices over so the admin confirms in one click. Remembered until then.
  const before = existing?.pending as PendingRows | null | undefined;
  const renamed = existing
    ? null
    : findRenamed(sheet.headers, await confirmedReports(orgId));
  let mapping: ColumnMapping;
  if (existing?.mapping) {
    mapping = existing.mapping as unknown as ColumnMapping;
  } else if (renamed) {
    mapping = renamed.mapping;
  } else {
    mapping = await suggest(orgId, sheet);
  }
  if (renamed) {
    pending.replaces = {
      report: renamed.report,
      renamed: renamed.renamed,
      removed: renamed.removed,
      added: renamed.added,
      complete: renamed.complete,
    };
  } else if (before?.replaces) {
    pending.replaces = before.replaces;
  }
  const data = {
    name: sheet.name,
    headers: sheet.headers,
    entity: mapping.entity,
    mapping: mapping as object,
    ...(renamed ? { mode: renamed.mode } : {}),
    status: "needs_mapping",
    pending: pending as object,
    lastReceivedAt: now,
  };
  let reportId = existing?.id;
  if (existing) {
    await db.erpReport.updateMany({ where: { id: existing.id }, data });
  } else {
    reportId = (
      await db.erpReport.create({
        data: { orgId, headerKey: key, ...data },
        select: { id: true },
      })
    ).id;
  }
  return {
    status: "needs_mapping",
    report: sheet.name,
    entity: mapping.entity,
    reportId,
    ...(pending.replaces ? { replaces: pending.replaces } : {}),
  };
};

export { confirmReport } from "./report-confirm";
