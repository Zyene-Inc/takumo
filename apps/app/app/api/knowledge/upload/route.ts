import { auth } from "@repo/auth/server";
import { authorize } from "@/lib/access";
import { featureProblem } from "@/lib/billing";
import { DocumentExistsError, documentNamed } from "@/lib/knowledge/documents";
import { ingestDocument } from "@/lib/knowledge/ingest";
import { streamSteps } from "@/lib/knowledge/stream";
import { fileFrom } from "@/lib/knowledge/upload-file";
import { requireCapability } from "@/lib/library/access";
import { checkDocumentFile } from "@/lib/library/files";
import { authorizeDocument, authorizeFolder } from "@/lib/library/guard";
import { libraryEnabled } from "@/lib/library/stage";
import { resolveViewer, type Viewer } from "@/lib/library/viewer";

// Long scans are read a few pages at a time.
export const maxDuration = 300;

const problem = (status: number, error: string) =>
  Response.json({ error }, { status });

/**
 * Upload one document. The response streams each step as it finishes (see
 * streamSteps), so the page can show the work as it happens.
 */
/** A clash with a live document: what the person may do about it. */
const nameTaken = async (
  existing: { id: string; name: string },
  viewer: Viewer | null
) => {
  // The existing document is named only to someone who may see it, and the
  // page offers a new version only to someone who may edit it.
  const visible = viewer
    ? await authorizeDocument(viewer, existing.id, "view")
    : null;
  const editable =
    viewer && visible?.ok
      ? await authorizeDocument(viewer, existing.id, "edit")
      : null;
  return Response.json(
    {
      error: new DocumentExistsError(existing.name).message,
      code: "name_taken",
      ...(visible?.ok
        ? {
            existing: {
              id: existing.id,
              name: existing.name,
              canAddVersion: Boolean(editable?.ok),
            },
          }
        : {}),
    },
    { status: 409 }
  );
};

/** The folder to upload into, when one is chosen (the library). */
const targetFolder = async (
  orgId: string,
  viewer: Viewer | null,
  raw: FormDataEntryValue | null
): Promise<{ ok: true; folderId: string | null } | Response> => {
  if (raw === null || raw === "") {
    return { ok: true, folderId: null };
  }
  if (!(viewer && typeof raw === "string" && (await libraryEnabled(orgId)))) {
    return problem(404, "That folder doesn't exist.");
  }
  const allowed = await authorizeFolder(viewer, raw, "upload");
  if (!allowed.ok) {
    return problem(allowed.status, allowed.error);
  }
  if (allowed.folder.kind.startsWith("virtual")) {
    return problem(400, "Documents can't be added to that folder.");
  }
  return { ok: true, folderId: allowed.folder.id };
};

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
  const form = await request.formData();
  const viewer = await resolveViewer();
  const target = await targetFolder(access.orgId, viewer, form.get("folderId"));
  if (target instanceof Response) {
    return target;
  }
  const file = await fileFrom(access.orgId, form);
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
  const existing = await documentNamed(
    access.orgId,
    file.name,
    target.folderId
  );
  // Someone who can't see this folder's documents (a drop box) is never
  // told what's in it: a clash is stored as "Name (2)" instead.
  const hidden = Boolean(
    target.folderId &&
      viewer &&
      !(await requireCapability(viewer, { folderId: target.folderId }, "view"))
        .ok
  );
  if (existing && !hidden) {
    return nameTaken(existing, viewer);
  }
  return streamSteps((emit) =>
    ingestDocument(access.orgId, userId ?? null, file, emit, {
      via: "upload",
      folderId: target.folderId,
      hidden,
    })
  );
};
