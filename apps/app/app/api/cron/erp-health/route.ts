import { timingSafeEqual } from "node:crypto";
import { database } from "@repo/database";
import { env } from "@/env";
import { PROVIDER_NAME, type Provider } from "@/lib/connectors/config";
import { healthLines, lateReports } from "@/lib/erp/health";
import { notifyAdmins } from "@/lib/notify";

// Once a day (vercel.json, 15:00 UTC: morning in the US): tell each shop's
// admins about ERP reports that stopped arriving and mailboxes that
// disconnected, so stale data gets noticed before it misleads anyone.
export const maxDuration = 120;

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
  const [reports, broken] = await Promise.all([
    database.erpReport.findMany({
      where: { status: "active" },
      select: {
        id: true,
        orgId: true,
        name: true,
        status: true,
        lastReceivedAt: true,
        updatedAt: true,
      },
    }),
    database.connection.findMany({
      where: { status: "error" },
      select: {
        orgId: true,
        provider: true,
        accountLabel: true,
        account: true,
      },
    }),
  ]);
  const orgs = new Set([
    ...reports.map((r) => r.orgId),
    ...broken.map((c) => c.orgId),
  ]);
  const notified: { orgId: string; late: number; mailboxes: number }[] = [];
  for (const orgId of orgs) {
    const late = lateReports(
      reports.filter((r) => r.orgId === orgId),
      now
    );
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
      late.length ? "/settings/integrations/email" : "/settings/integrations"
    );
    if (late.length) {
      await database.erpReport.updateMany({
        where: { id: { in: late.map((r) => r.id) } },
        data: { lastAlertAt: now },
      });
    }
    notified.push({ orgId, late: late.length, mailboxes: mailboxes.length });
  }
  return Response.json({ ok: true, notified });
};
