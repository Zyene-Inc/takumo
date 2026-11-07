import { z } from "zod";
import { fromCron } from "@/lib/cron";
import { INLINE_BUDGET_MS } from "@/lib/knowledge/ingest";
import { scheduleHandOff } from "@/lib/library/handoff";
import { processVersion } from "@/lib/library/process";

// Continues processing a document version in a fresh run, when the run
// before it ran out of time. Only Takumo calls it (with the cron secret);
// the library sweep does the same job if this call never arrives.
export const maxDuration = 300;

const Body = z.object({ versionId: z.uuid() });

export const POST = async (request: Request) => {
  if (!fromCron(request)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Which version?" }, { status: 400 });
  }
  const { versionId } = parsed.data;
  const run = await processVersion(versionId, {
    deadline: Date.now() + INLINE_BUDGET_MS,
  });
  if (run.result === "handoff") {
    scheduleHandOff(versionId);
  }
  return Response.json({ ok: true, result: run.result });
};
