import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import type { ColumnMapping } from "@repo/ingest";
import type { KnownReport } from "./renamed";
import { DUPLICATE_WITHIN_MS } from "./reports";

/** The same file as the last import, within a resend's time: skip it. */
export const isResend = (
  report: { lastImportAt: Date | null; lastResult: unknown },
  fileHash: string,
  now: Date
) => {
  const last = report.lastResult as { fileHash?: string } | null;
  return Boolean(
    report.lastImportAt &&
      last?.fileHash === fileHash &&
      now.getTime() - report.lastImportAt.getTime() < DUPLICATE_WITHIN_MS
  );
};

/** Reports whose columns the shop confirmed: what a renamed one may be. */
export const confirmedReports = async (
  orgId: string
): Promise<KnownReport[]> => {
  const rows = await forOrg(database, orgId).erpReport.findMany({
    where: {
      status: { in: ["active", "paused"] },
      mapping: { not: Prisma.DbNull },
    },
    select: { id: true, name: true, headers: true, mapping: true, mode: true },
  });
  return rows.map((r) => ({
    ...r,
    mapping: r.mapping as unknown as ColumnMapping,
  }));
};
