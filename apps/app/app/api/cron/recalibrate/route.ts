import { timingSafeEqual } from "node:crypto";
import { database } from "@repo/database";
import { log } from "@repo/observability/log";
import { env } from "@/env";
import { recalibrate } from "@/lib/facts/recalibrate";

// Every shop's finished jobs, compared with its routings.
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

/**
 * Nightly recalibration (vercel.json crons, 07:00 UTC): proposes a fact for
 * every operation whose actual times have drifted from its routing. Shops
 * with no finished jobs in the window are skipped quickly.
 */
export const GET = async (request: Request) => {
  if (!authorized(request.headers.get("authorization"))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const orgs = await database.org.findMany({
    where: { jobs: { some: { actualEnd: { not: null } } } },
    select: { id: true },
  });
  const results: Record<
    string,
    { proposed: string[]; refreshed: string[] } | { error: string }
  > = {};
  for (const org of orgs) {
    try {
      const r = await recalibrate(org.id);
      results[org.id] = { proposed: r.proposed, refreshed: r.refreshed };
    } catch (error) {
      log.error("Recalibration failed", {
        orgId: org.id,
        error: String(error),
      });
      results[org.id] = { error: "failed" };
    }
  }
  return Response.json({ shops: orgs.length, results });
};
