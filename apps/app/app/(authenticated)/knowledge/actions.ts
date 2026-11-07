"use server";

import { database } from "@repo/database";
import { revalidatePath } from "next/cache";
import { authorize } from "@/lib/access";
import { authorizeDocument } from "@/lib/library/guard";
import { scheduleHandOff } from "@/lib/library/handoff";
import { requeueVersion } from "@/lib/library/lease";
import {
  purgeDocument as purge,
  restoreDocument as restore,
  trashDocument,
} from "@/lib/library/lifecycle";
import { resolveViewer } from "@/lib/library/viewer";
import { keepUploadPart } from "@/lib/quotes/upload-parts";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const NO_VIEWER = { ok: false, error: "That document doesn't exist." } as const;

const plain = <T extends object>(
  outcome: ({ ok: true } & T) | { ok: false; error: string; status: number }
): Result<T> => (outcome.ok ? outcome : { ok: false, error: outcome.error });

/**
 * Delete a document: it goes to the Trash, gone at once from the library,
 * search and Ask, and can be restored. (It used to be erased on the spot.)
 */
export const deleteDocument = async (sourceId: string): Promise<Result> => {
  const viewer = await resolveViewer();
  if (!viewer) {
    return NO_VIEWER;
  }
  const result = plain(await trashDocument(viewer, sourceId));
  revalidatePath("/knowledge");
  return result;
};

/** Bring a document back from the Trash. */
export const restoreDocument = async (
  sourceId: string
): Promise<Result<{ name: string }>> => {
  const viewer = await resolveViewer();
  if (!viewer) {
    return NO_VIEWER;
  }
  const result = plain(await restore(viewer, sourceId));
  revalidatePath("/knowledge");
  return result;
};

/**
 * Delete a document for good (from the Trash). `complete` is false while its
 * stored files are still being deleted.
 */
export const purgeDocument = async (
  sourceId: string
): Promise<Result<{ complete: boolean }>> => {
  const viewer = await resolveViewer();
  if (!viewer) {
    return NO_VIEWER;
  }
  const result = plain(await purge(viewer, sourceId));
  revalidatePath("/knowledge");
  return result;
};

/**
 * Try a failed version again: whoever uploaded it, or anyone who may edit
 * the document.
 */
export const retryVersion = async (
  sourceId: string,
  versionId: string
): Promise<Result> => {
  const viewer = await resolveViewer();
  if (!viewer) {
    return NO_VIEWER;
  }
  const visible = await authorizeDocument(viewer, sourceId, "view", {
    trashed: true,
  });
  if (!visible.ok) {
    return plain(visible);
  }
  const version = await database.documentVersion.findFirst({
    where: { id: versionId, sourceId, orgId: viewer.orgId },
    select: { uploadedBy: true },
  });
  const own = Boolean(viewer.userId && version?.uploadedBy === viewer.userId);
  if (!own) {
    const editable = await authorizeDocument(viewer, sourceId, "edit", {
      trashed: true,
    });
    if (!editable.ok) {
      return plain(editable);
    }
  }
  if (!(await requeueVersion(viewer.orgId, sourceId, versionId))) {
    return { ok: false, error: "That version isn't waiting to be retried." };
  }
  scheduleHandOff(versionId);
  return { ok: true };
};

/** One piece of a large document upload (requests are capped at 4.5 MB). */
export const uploadKnowledgePart = async (
  form: FormData
): Promise<{ ok: true } | { ok: false; error: string }> => {
  const access = await authorize("knowledge:share");
  if (!access.ok) {
    return access;
  }
  const blob = form.get("part");
  if (!(blob instanceof Blob)) {
    return { ok: false, error: "That upload isn't valid. Try again." };
  }
  const problem = await keepUploadPart(
    access.orgId,
    {
      uploadId: String(form.get("uploadId") ?? ""),
      fileIndex: 0,
      partIndex: Number(form.get("partIndex")),
      name: String(form.get("name") ?? ""),
    },
    new Uint8Array(await blob.arrayBuffer())
  );
  return problem ? { ok: false, error: problem } : { ok: true };
};
