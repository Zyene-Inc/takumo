import { authorize } from "@/lib/access";
import { featureProblem } from "@/lib/billing";
import { rereadDocument } from "@/lib/knowledge/ingest";
import { streamSteps } from "@/lib/knowledge/stream";
import { authorizeDocument } from "@/lib/library/guard";
import { resolveViewer } from "@/lib/library/viewer";

export const maxDuration = 300;

const problem = (status: number, error: string) =>
  Response.json({ error }, { status });

/**
 * Read a stored document again, streaming each step (see streamSteps). Needs
 * edit on that document itself, not only the role.
 */
export const POST = async (request: Request) => {
  const access = await authorize("knowledge:write");
  if (!access.ok) {
    return problem(403, access.error);
  }
  const viewer = await resolveViewer();
  if (!(viewer && viewer.orgId === access.orgId)) {
    return problem(401, "Sign in again.");
  }
  const { userId } = viewer;
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
  const allowed = await authorizeDocument(viewer, sourceId, "edit");
  if (!allowed.ok) {
    return problem(allowed.status, allowed.error);
  }
  return streamSteps((emit) =>
    rereadDocument(access.orgId, userId ?? null, sourceId, emit)
  );
};
