"use server";

import { auth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { log } from "@repo/observability/log";
import { revalidatePath } from "next/cache";
import { featureProblem } from "@/lib/billing";
import {
  canTranscribe,
  shopVocabulary,
  transcribeAudio,
} from "@/lib/facts/transcribe";

// About 4 minutes of 16 kHz mono WAV, the format the composer records in.
const MAX_DICTATION_BYTES = 8 * 1024 * 1024;

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

/** Speech to text for the Ask composer's Dictate button. */
export const dictate = async (
  form: FormData
): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
  const { orgId, userId } = await auth();
  if (!(orgId && userId)) {
    return { ok: false, error: "Sign in first." };
  }
  if (!canTranscribe()) {
    return { ok: false, error: "Dictation isn't set up for this shop." };
  }
  const locked = await featureProblem(orgId, "ask");
  if (locked) {
    return { ok: false, error: locked };
  }
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return { ok: false, error: "Nothing was recorded. Try again." };
  }
  if (audio.size > MAX_DICTATION_BYTES) {
    return { ok: false, error: "Keep dictation under 4 minutes." };
  }
  try {
    const { text } = await transcribeAudio(
      new Uint8Array(await audio.arrayBuffer()),
      await shopVocabulary(orgId)
    );
    return text
      ? { ok: true, text }
      : { ok: false, error: "Didn't catch that. Try again, a bit closer." };
  } catch (error) {
    log.error("Dictation failed", { error });
    return { ok: false, error: "Couldn't transcribe that. Try again." };
  }
};
