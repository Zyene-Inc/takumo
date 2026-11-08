import "server-only";

import { timingSafeEqual } from "node:crypto";
import { env } from "@/env";

/** The request carries the cron secret (Vercel cron, or a hand-off between runs). */
export const fromCron = (request: Request) => {
  const secret = env.CRON_SECRET;
  const header = request.headers.get("authorization");
  if (!(secret && header)) {
    return false;
  }
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
};
