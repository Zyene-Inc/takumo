import { auth } from "@repo/auth/server";
import { authorize } from "@/lib/access";
import { featureProblem } from "@/lib/billing";
import { DocumentExistsError, documentNamed } from "@/lib/knowledge/documents";
import { ingestDocument } from "@/lib/knowledge/ingest";
import { streamSteps } from "@/lib/knowledge/stream";
import { fileFrom } from "@/lib/knowledge/upload-file";
import { checkDocumentFile } from "@/lib/library/files";

// Long scans are read a few pages at a time.
export const maxDuration = 300;

const problem = (status: number, error: string) =>
  Response.json({ error }, { status });

/**
 * Upload one document. The response streams each step as it finishes (see
 * streamSteps), so the page can show the work as it happens.
 */
export const POST = async (request: Request) => {
  const access = await authorize("knowledge:share");
  if (!access.ok) {
    return problem(403, access.error);
  }
  // The uploader is the signed-in person, never something the form says.
  const { userId } = await auth();
  const locked = await featureProblem(access.orgId, "knowledge");
  if (locked) {
    return problem(402, locked);
  }
  const file = await fileFrom(access.orgId, await request.formData());
  if (!file) {
    return problem(400, "Choose a file.");
  }
  // Size, type and content (a renamed file is refused) before anything is kept.
  const check = checkDocumentFile(file.name, file.bytes);
  if (!check.ok) {
    return problem(400, check.error);
  }
  // Uploading never replaces a document, whoever uploads: a new version is
  // its own action (api/library/documents/[sourceId]/versions). Checked here
  // so nothing is stored for nothing, and again (under a lock) when the
  // document is created, in case one with this name arrived meanwhile.
  const existing = await documentNamed(access.orgId, file.name);
  if (existing) {
    // `code` lets the page offer "upload as a new version" (phase 3).
    return Response.json(
      {
        error: new DocumentExistsError(existing.name).message,
        code: "name_taken",
      },
      { status: 409 }
    );
  }
  return streamSteps((emit) =>
    ingestDocument(access.orgId, userId ?? null, file, emit, { via: "upload" })
  );
};
