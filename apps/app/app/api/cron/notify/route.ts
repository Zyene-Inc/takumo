import { timingSafeEqual } from "node:crypto";
import { env } from "@/env";
import { runAlerts } from "@/lib/alerts/run";
import { runBriefs } from "@/lib/brief/run";

// Every 15 minutes (vercel.json): morning briefs that are due (each person's
// own time, F4.1) and alerts about what just changed (F4.3).
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
  const now = new Date();
  const [briefs, alerts] = await Promise.all([runBriefs(now), runAlerts(now)]);
  return Response.json({ ok: true, briefs, alerts });
};
