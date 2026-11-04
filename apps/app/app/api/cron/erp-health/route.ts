import { timingSafeEqual } from "node:crypto";
import { database } from "@repo/database";
import { env } from "@/env";
import { PROVIDER_NAME, type Provider } from "@/lib/connectors/config";
import { healthLines, lateReports } from "@/lib/erp/health";
import { reportLink } from "@/lib/erp/link";
import { notifyAdmins } from "@/lib/notify";
import { markAllEnteredFromErp } from "@/lib/orders/settle";
import { removeOldFiltered } from "@/lib/quotes/screening";
import { settleAllFromErp } from "@/lib/quotes/settle";
import { removeOldUploadParts } from "@/lib/quotes/upload-parts";

/** A mailbox failing this long without a good check counts as broken. */
const FAILING_FOR_MS = 26 * 60 * 60 * 1000;

// Once a day (vercel.json, 15:00 UTC: morning in the US): tell each shop's
// admins about ERP reports that stopped arriving and mailboxes that
// disconnected, so stale data gets noticed before it misleads anyone. Also
// settles quotes the ERP's orders answered.
export const maxDuration = 120;

/** Straight to the report when there's one, else the reports page. */
const reportPath = (late: number, only: string | undefined) => {
  if (late === 0) {
    return "/settings/integrations";
  }
  return reportLink(late === 1 ? only : undefined);
};

const authorized = (header: string | null) => {
  const secret = env.CRON_SECRET;
  if (!(secret && header)) {
    return false;
  }
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
};

export const GET = async (request: Request) => {
  if (!authorized(request.headers.get("authorization"))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const now = new Date();
  // Housekeeping: pieces of uploads that were never submitted.
  await removeOldUploadParts(now.getTime()).catch(() => 0);
  await removeOldFiltered(now.getTime()).catch(() => 0);
  const [reports, broken, renames] = await Promise.all([
    database.erpReport.findMany({
      where: { status: "active" },
      select: {
        id: true,
        orgId: true,
        name: true,
        status: true,
        lastReceivedAt: true,
        lastImportAt: true,
        updatedAt: true,
      },
    }),
    database.connection.findMany({
      // Broken, or still "connected" but failing for over a day (an outage,
      // a rate limit that never clears): either way RFQs aren't coming in.
      where: {
        OR: [
          { status: "error" },
          {
            status: "connected",
            lastError: { not: null },
            OR: [
              { lastSyncAt: null },
              { lastSyncAt: { lt: new Date(now.getTime() - FAILING_FOR_MS) } },
            ],
          },
        ],
      },
      select: {
        orgId: true,
        provider: true,
        accountLabel: true,
        account: true,
      },
    }),
    // Reports waiting for a click because the ERP renamed their columns.
    // Only the one field: pending also holds up to 20,000 waiting rows.
    database.$queryRaw<{ id: string; name: string; old: string }[]>`
      SELECT id, name, pending->'replaces'->'report'->>'id' AS old
      FROM "ErpReport"
      WHERE status = 'needs_mapping'
        AND pending->'replaces'->'report'->>'id' IS NOT NULL`,
  ]);
  const waiting = new Map(
    renames.map((r) => [r.old, { id: r.id, name: r.name }] as const)
  );
  const orgs = new Set([
    ...reports.map((r) => r.orgId),
    ...broken.map((c) => c.orgId),
  ]);
  const notified: { orgId: string; late: number; mailboxes: number }[] = [];
  for (const orgId of orgs) {
    const late = lateReports(
      reports.filter((r) => r.orgId === orgId),
      now
    ).map((r) => ({ ...r, renamedTo: waiting.get(r.id)?.name }));
    const [onlyLate] = late;
    const mailboxes = broken
      .filter((c) => c.orgId === orgId)
      .map(
        (c) =>
          `${PROVIDER_NAME[c.provider as Provider] ?? c.provider} (${c.accountLabel ?? c.account})`
      );
    if (late.length === 0 && mailboxes.length === 0) {
      continue;
    }
    await notifyAdmins(
      orgId,
      late.length ? "ERP data is going stale" : "a connection stopped working",
      [
        "Takumo's data from your systems needs attention:",
        ...healthLines(late, mailboxes, now),
      ],
      reportPath(
        late.length,
        onlyLate && (waiting.get(onlyLate.id)?.id ?? onlyLate.id)
      )
    );
    if (late.length) {
      await database.erpReport.updateMany({
        where: { id: { in: late.map((r) => r.id) } },
        data: { lastAlertAt: now },
      });
    }
    notified.push({ orgId, late: late.length, mailboxes: mailboxes.length });
  }
  // Quotes answered by ERP orders, or unanswered for 60 days (F2.7).
  const settled = await settleAllFromErp(now);
  // Customer POs whose order the ERP now has.
  const posEntered = await markAllEnteredFromErp().catch(() => 0);
  return Response.json({ ok: true, notified, settled, posEntered });
};
