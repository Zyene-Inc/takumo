import { log } from "@repo/observability/log";
import { fromCron } from "@/lib/cron";
import { sweepLibrary } from "@/lib/library/sweep";

// Every 5 minutes (vercel.json): resumes document processing that stopped,
// retries failed versions that are due, and finishes deleting stored files.
export const maxDuration = 300;

export const GET = async (request: Request) => {
  if (!fromCron(request)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const swept = await sweepLibrary();
  log.info("Library sweep", swept);
  return Response.json({ ok: true, ...swept });
};
