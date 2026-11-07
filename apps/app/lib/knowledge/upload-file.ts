import "server-only";

import { isUploadId } from "../quotes/upload-limits";
import { takeUpload } from "../quotes/upload-parts";

/** The file: sent whole (small) or in pieces first (uploadKnowledgePart). */
export const fileFrom = async (orgId: string, form: FormData) => {
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
