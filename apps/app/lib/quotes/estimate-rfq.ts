import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import { estimateLine, loadQuoteHistory } from "./estimate";

/** Lines estimated at once (each runs the scheduler). */
const PARALLEL_LINES = 2;

/**
 * Estimate every line of an RFQ without a draft (all of them with `redo`),
 * then mark it "drafted" once every line has one. Used by the estimator's
 * "Draft quote" button and, for RFQs arriving by email, straight after
 * reading.
 */
export const estimateRfqLines = async (
  orgId: string,
  rfqId: string,
  today: string,
  redo = false
) => {
  const db = forOrg(database, orgId);
  const lines = await db.rfqLine.findMany({
    where: { rfqId },
    orderBy: { lineNo: "asc" },
    select: { id: true, lineNo: true, draft: true },
  });
  const history = await loadQuoteHistory(orgId);
  const todo = lines.filter((l) => redo || !l.draft);
  const errors: string[] = [];
  for (let i = 0; i < todo.length; i += PARALLEL_LINES) {
    const batch = todo.slice(i, i + PARALLEL_LINES);
    const results = await Promise.all(
      batch.map((l) => estimateLine(orgId, l.id, today, history))
    );
    results.forEach((r, j) => {
      if (!r.ok) {
        errors.push(`Line ${batch[j].lineNo}: ${r.error}`);
      }
    });
  }
  const drafted = await db.rfqLine.count({
    where: { rfqId, draft: { not: Prisma.DbNull } },
  });
  // Only while it's still being drafted: someone may have approved it meanwhile.
  await db.rfq.updateMany({
    where: { id: rfqId, status: { in: ["review", "drafted"] } },
    data: { status: drafted === lines.length ? "drafted" : "review" },
  });
  return { drafted, total: lines.length, attempted: todo.length, errors };
};
