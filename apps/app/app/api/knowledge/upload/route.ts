import { can } from "@repo/auth/permissions";
import { auth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { authorize } from "@/lib/access";
import { featureProblem } from "@/lib/billing";
import { ingestDocument } from "@/lib/knowledge/ingest";
import { streamSteps } from "@/lib/knowledge/stream";
import { DOCUMENT_TYPES, MAX_DOCUMENT_BYTES } from "@/lib/knowledge/types";
import { isUploadId } from "@/lib/quotes/upload-limits";
import { takeUpload } from "@/lib/quotes/upload-parts";

// Long scans are read a few pages at a time.
export const maxDuration = 300;

const problem = (status: number, error: string) =>
  Response.json({ error }, { status });

/**
 * Upload one document. The response streams each step as it finishes (see
 * streamSteps), so the page can show the work as it happens.
 */
/** The file: sent whole (small) or in pieces first (uploadKnowledgePart). */
const fileFrom = async (orgId: string, form: FormData) => {
  const uploadId = String(form.get("uploadId") ?? "");
  if (uploadId) {
    if (!isUploadId(uploadId)) {
      return null;
    }
    const [file] = await takeUpload(orgId, uploadId);
    return file ?? null;
  }
  const file = form.get("file");
  return file instanceof File && file.size > 0
    ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
    : null;
};

export const POST = async (request: Request) => {
  const access = await authorize("knowledge:share");
  if (!access.ok) {
    return problem(403, access.error);
  }
  const { userId, role } = await auth();
  const locked = await featureProblem(access.orgId, "knowledge");
  if (locked) {
    return problem(402, locked);
  }
  const file = await fileFrom(access.orgId, await request.formData());
  if (!file) {
    return problem(400, "Choose a file.");
  }
  if (file.bytes.length > MAX_DOCUMENT_BYTES) {
    return problem(400, "Files can be up to 20 MB.");
  }
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!(DOCUMENT_TYPES as readonly string[]).includes(ext)) {
    return problem(400, `Takumo reads ${DOCUMENT_TYPES.join(", ")} files.`);
  }
  // A document with the same name is replaced; only people who can remove
  // documents may do that, so nobody overwrites an SOP by accident.
  if (!can(role, "knowledge:write")) {
    const existing = await forOrg(database, access.orgId).source.findFirst({
      where: { name: file.name, type: "upload", profile: "document" },
      select: { id: true },
    });
    if (existing) {
      return problem(
        409,
        `There's already a document called ${file.name}. Rename your file, or ask an admin to replace it.`
      );
    }
  }
  return streamSteps((emit) =>
    ingestDocument(access.orgId, userId ?? null, file, emit)
  );
};
