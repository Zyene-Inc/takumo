"use server";

import { auth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { revalidatePath } from "next/cache";

/** Delete one of your own conversations. */
export const deleteConversation = async (
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> => {
  const { orgId, userId } = await auth();
  if (!(orgId && userId)) {
    return { ok: false, error: "Sign in first." };
  }
  const { count } = await forOrg(database, orgId).conversation.deleteMany({
    where: { id, userId },
  });
  revalidatePath("/ask");
  revalidatePath("/ask/history");
  return count ? { ok: true } : { ok: false, error: "Conversation not found." };
};
