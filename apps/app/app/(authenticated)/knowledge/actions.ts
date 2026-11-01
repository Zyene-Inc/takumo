"use server";

import { database, forOrg } from "@repo/database";
import { revalidatePath } from "next/cache";
import { authorize } from "@/lib/access";

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
