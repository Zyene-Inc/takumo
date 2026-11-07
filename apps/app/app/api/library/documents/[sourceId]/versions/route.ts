import { featureProblem } from "@/lib/billing";
import { ingestVersion } from "@/lib/knowledge/ingest";
import { streamSteps } from "@/lib/knowledge/stream";
import { fileFrom } from "@/lib/knowledge/upload-file";
import { checkDocumentFile } from "@/lib/library/files";
import { authorizeDocument } from "@/lib/library/guard";
import { resolveViewer } from "@/lib/library/viewer";

// Long scans are read a few pages at a time.
export const maxDuration = 300;

const problem = (status: number, error: string) =>
  Response.json({ error }, { status });

/**
 * Upload a new version of a document: the explicit action that replaces
 * what Takumo reads for it. Needs edit on the document. The current version
 * stays in use until the new one has been read; a failed new version leaves
 * it as it was. Streams each step, like an upload.
 */
export const POST = async (
  request: Request,
  { params }: { params: Promise<{ sourceId: string }> }
) => {
  const viewer = await resolveViewer();
  if (!viewer?.userId) {
    return problem(404, "That document doesn't exist.");
  }
  const { sourceId } = await params;
  const allowed = await authorizeDocument(viewer, sourceId, "edit");
  if (!allowed.ok) {
    return problem(allowed.status, allowed.error);
  }
  const locked = await featureProblem(viewer.orgId, "knowledge");
  if (locked) {
    return problem(402, locked);
  }
  const file = await fileFrom(viewer.orgId, await request.formData());
  if (!file) {
    return problem(400, "Choose a file.");
  }
  const check = checkDocumentFile(file.name, file.bytes);
  if (!check.ok) {
    return problem(400, check.error);
  }
  const userId = viewer.userId;
  return streamSteps(async (emit) => {
    const made = await ingestVersion(
      viewer.orgId,
      userId,
      sourceId,
      file,
      emit
    );
    if (!made) {
      throw new Error("No text found: that document isn't stored any more.");
    }
  });
};
