import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import {
  type ColumnMapping,
  ENTITIES,
  type EntityKey,
  missingRequired,
  parseRows,
} from "@repo/ingest";
import { suggestMappingWithAi } from "@repo/ingest/ai-mapping";
import { saveRecords } from "@repo/ingest/save";
import { log } from "@repo/observability/log";
import type { Sheet } from "@/app/(authenticated)/onboarding/read-file";
import { budgetProblem, recordUsage } from "../ai-usage";
import { headerKey } from "./sheets";

// A shop's ERP emails the same reports every night (docs/PRODUCT-PLAN.md
// F1.3). The first time a report arrives Takumo suggests what its columns
// mean and an admin confirms; from then on it imports with no one involved.

/** Rows kept from an unconfirmed report until its columns are confirmed. */
const MAX_PENDING_ROWS = 20_000;
export const REPORT_MODES = ["full", "changes"] as const;
export type ReportMode = (typeof REPORT_MODES)[number];

export interface ReportResult {
  /** Records the ERP no longer lists (full reports): closed, received, zeroed. */
  closed: number;
  created: number;
  errors: number;
  notes: string[];
  skipped: number;
  updated: number;
}

interface PendingRows {
  fileName: string;
  firstRow: number;
  rows: Sheet["rows"];
}

export type SheetOutcome =
  | { status: "imported"; report: string; result: ReportResult }
  | { status: "needs_mapping"; report: string; entity: EntityKey }
  | { status: "paused" | "failed"; report: string; error?: string };

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

/** Import rows with a confirmed mapping, stamped as coming from the ERP. */
export const importReportRows = async (
  orgId: string,
  report: { id: string; name: string; mode: string },
  mapping: ColumnMapping,
  pending: PendingRows
): Promise<ReportResult> => {
  const { records, errors } = parseRows(
    pending.rows,
    mapping,
    pending.firstRow
  );
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
  // Only when the whole file was read: a half-read report would close
  // records that are still open.
  const rowErrors = new Set(
    errors.filter((e) => e.severity === "error").map((e) => e.row)
  ).size;
  const closed =
    report.mode === "full" && rowErrors === 0
      ? await closeMissing(orgId, mapping.entity, syncedAt)
      : 0;
  const notes = [...saved.notes];
  if (closed) {
    notes.push(`${closed} ${CLOSED_WORD[mapping.entity] ?? "records closed"}`);
  }
  if (report.mode === "full" && rowErrors > 0) {
    notes.push(
      `${rowErrors} rows couldn't be read, so nothing was closed this time`
    );
  }
  const result: ReportResult = {
    created: saved.created,
    updated: saved.updated,
    skipped: saved.skipped + rowErrors,
    errors: rowErrors,
    closed,
    notes,
  };
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
  const pending: PendingRows = {
    fileName: sheet.name,
    firstRow: sheet.firstRow,
    rows: sheet.rows.slice(0, MAX_PENDING_ROWS),
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
    try {
      const result = await importReportRows(
        orgId,
        existing,
        existing.mapping as unknown as ColumnMapping,
        pending
      );
      return { status: "imported", report: sheet.name, result };
    } catch (error) {
      log.error("ERP report import failed", { orgId, error: String(error) });
      return {
        status: "failed",
        report: sheet.name,
        error: "Saving the rows failed; the next report will try again.",
      };
    }
  }
  const mapping = existing?.mapping
    ? (existing.mapping as unknown as ColumnMapping)
    : await suggest(orgId, sheet);
  const data = {
    name: sheet.name,
    headers: sheet.headers,
    entity: mapping.entity,
    mapping: mapping as object,
    status: "needs_mapping",
    pending: pending as object,
    lastReceivedAt: now,
  };
  if (existing) {
    await db.erpReport.updateMany({ where: { id: existing.id }, data });
  } else {
    await db.erpReport.create({ data: { orgId, headerKey: key, ...data } });
  }
  return {
    status: "needs_mapping",
    report: sheet.name,
    entity: mapping.entity,
  };
};

/**
 * An admin confirms what a report's columns mean (and whether it lists
 * everything): the waiting rows are imported and later reports run alone.
 */
export const confirmReport = async (
  orgId: string,
  reportId: string,
  mapping: ColumnMapping,
  mode: ReportMode
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
  if (!pending?.rows?.length) {
    return { ok: true, result: null };
  }
  const result = await importReportRows(
    orgId,
    { id: report.id, name: report.name, mode },
    mapping,
    pending
  );
  return { ok: true, result };
};
