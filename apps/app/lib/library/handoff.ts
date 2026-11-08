import "server-only";

import { log } from "@repo/observability/log";
import { after } from "next/server";
import { env } from "@/env";

// Starting the next run of a version straight away, when this one ran out of
// time. Only a shortcut: nothing relies on it. after() may not get a fresh
// execution window and the request below may be cut off; the library sweep
// (/api/cron/library) finds any version whose lease ran out and resumes it.

/** Long enough for the next run to start; it doesn't wait for it to finish. */
const START_TIMEOUT_MS = 5000;

const start = async (versionId: string) => {
  const secret = env.CRON_SECRET;
  if (!secret) {
    return;
  }
  try {
    await fetch(`${env.NEXT_PUBLIC_APP_URL}/api/cron/library/process`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ versionId }),
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
    });
  } catch (error) {
    // Timing out here is expected; the sweep covers anything else.
    if (!(error instanceof Error && error.name === "TimeoutError")) {
      log.warn("Handing off document processing failed", {
        versionId,
        error: String(error),
      });
    }
  }
};

export const scheduleHandOff = (versionId: string) => {
  try {
    after(() => start(versionId));
  } catch {
    // Outside a request (tests, scripts): the sweep will pick it up.
  }
};
