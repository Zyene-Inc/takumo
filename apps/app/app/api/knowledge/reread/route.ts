import { auth } from "@repo/auth/server";
import { authorize } from "@/lib/access";
import { featureProblem } from "@/lib/billing";
import { rereadDocument } from "@/lib/knowledge/ingest";
import { streamSteps } from "@/lib/knowledge/stream";

export const maxDuration = 300;

const problem = (status: number, error: string) =>
  Response.json({ error }, { status });

/** Read a stored document again, streaming each step (see streamSteps). */
export const POST = async (request: Request) => {
  const access = await authorize("knowledge:write");
  if (!access.ok) {
    return problem(403, access.error);
  }
  const { userId } = await auth();
  const locked = await featureProblem(access.orgId, "knowledge");
  if (locked) {
    return problem(402, locked);
  }
  const body = (await request.json().catch(() => null)) as {
    sourceId?: unknown;
  } | null;
  if (typeof body?.sourceId !== "string") {
    return problem(400, "Which document?");
  }
  const sourceId = body.sourceId;
  return streamSteps((emit) =>
    rereadDocument(access.orgId, userId ?? null, sourceId, emit)
  );
};
