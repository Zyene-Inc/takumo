"use server";

import { database, forOrg } from "@repo/database";
import { log } from "@repo/observability/log";
import { revalidatePath } from "next/cache";
import { authorize } from "@/lib/access";
import {
  DOCUMENT_TYPES,
  extractPages,
  MAX_DOCUMENT_BYTES,
  saveDocument,
} from "@/lib/knowledge/documents";

export type UploadResult =
  | { ok: true; name: string; chunks: number }
  | { ok: false; error: string };

/** Read a document's text and make it searchable by Ask Takumo. */
export const uploadDocument = async (form: FormData): Promise<UploadResult> => {
  const access = await authorize("knowledge:write");
  if (!access.ok) {
    return access;
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose a file." };
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return { ok: false, error: "Files can be up to 20 MB." };
  }
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!(DOCUMENT_TYPES as readonly string[]).includes(ext)) {
    return {
      ok: false,
      error: `Takumo reads ${DOCUMENT_TYPES.join(", ")} files.`,
    };
  }
  try {
    const pages = await extractPages(
      file.name,
      new Uint8Array(await file.arrayBuffer())
    );
    const saved = await saveDocument(access.orgId, file.name, pages);
    revalidatePath("/knowledge");
    return { ok: true, name: saved.name, chunks: saved.chunks };
  } catch (error) {
    log.warn("Document upload failed", { error: String(error) });
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Couldn't read that file.",
    };
  }
};

export const deleteDocument = async (
  sourceId: string
): Promise<{ ok: true } | { ok: false; error: string }> => {
  const access = await authorize("knowledge:write");
  if (!access.ok) {
    return access;
  }
  await forOrg(database, access.orgId).source.deleteMany({
    where: { id: sourceId },
  });
  revalidatePath("/knowledge");
  return { ok: true };
};
