"use server";

import { database, forOrg } from "@repo/database";
import { revalidatePath } from "next/cache";
import { authorize } from "@/lib/access";
import { keepUploadPart } from "@/lib/quotes/upload-parts";

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
