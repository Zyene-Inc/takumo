import { timingSafeEqual } from "node:crypto";
import { database } from "@repo/database";
import { entitlements } from "@repo/payments/plans";
import { env } from "@/env";
import type { Provider } from "@/lib/connectors/config";
import { syncConnection } from "@/lib/connectors/sync";

// Every connected shop's QuickBooks, Gmail and Outlook (vercel.json crons,
// hourly). An Outlook check also renews its new-mail subscription when under
// a day is left, or recreates it if Microsoft dropped it.
export const maxDuration = 300;

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
  const connections = await database.connection.findMany({
    where: { status: "connected" },
    select: {
      orgId: true,
      provider: true,
      org: {
        select: {
          plan: true,
          trialEndsAt: true,
          subscriptionStatus: true,
          currentPeriodEnd: true,
          pastDueSince: true,
          cancelAtPeriodEnd: true,
        },
      },
    },
  });
  const results: {
    ok?: boolean;
    orgId: string;
    provider: string;
    skipped?: string;
  }[] = [];
  for (const c of connections) {
    // Shops whose plan no longer includes connectors are left alone.
    if (!entitlements(c.org).features.has("connectors")) {
      results.push({ orgId: c.orgId, provider: c.provider, skipped: "plan" });
      continue;
    }
    const r = await syncConnection(c.orgId, c.provider as Provider);
    results.push({ orgId: c.orgId, provider: c.provider, ok: r.ok });
  }
  return Response.json({ connections: connections.length, results });
};
