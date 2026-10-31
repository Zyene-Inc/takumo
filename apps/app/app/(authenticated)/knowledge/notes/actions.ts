"use server";

import { auth } from "@repo/auth/server";
import { revalidatePath } from "next/cache";
import { track } from "@/lib/analytics";
import { featureProblem } from "@/lib/billing";
import { rereadNote, saveNote } from "@/lib/facts/notes";
import {
  AUDIO_TYPES,
  MAX_AUDIO_BYTES,
  transcribeAudio,
} from "@/lib/facts/transcribe";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const MAX_NOTE_CHARS = 8000;

const refresh = () => {
  revalidatePath("/knowledge/notes");
  revalidatePath("/knowledge/facts");
};

/** Anyone in the shop can leave a note; facts in it wait for review. */
export const submitNote = async (note: {
  durationSec?: number | null;
  kind: "voice" | "typed";
  text: string;
}): Promise<Result<{ proposed: string[]; skipped: string[] }>> => {
  const { orgId, userId } = await auth();
  if (!orgId) {
    return { ok: false, error: "Choose a shop first." };
  }
  const locked = await featureProblem(orgId, "knowledge");
  if (locked) {
    return { ok: false, error: locked };
  }
  const text = note.text.trim();
  if (text.length < 3) {
    return { ok: false, error: "The note is empty." };
  }
  if (text.length > MAX_NOTE_CHARS) {
    return { ok: false, error: "Keep notes under 8,000 characters." };
  }
  const result = await saveNote(orgId, userId, {
    kind: note.kind === "voice" ? "voice" : "typed",
    text,
    durationSec: note.durationSec ?? null,
  });
  refresh();
  track("note_saved", {
    orgId,
    userId,
    properties: { kind: note.kind, facts: result.proposed.length },
  });
  return { ok: true, proposed: result.proposed, skipped: result.skipped };
};

/** Speech to text for a recording (needs OPENAI_API_KEY). */
export const transcribe = async (
  form: FormData
): Promise<Result<{ durationSec: number | null; text: string }>> => {
  const { orgId } = await auth();
  if (!orgId) {
    return { ok: false, error: "Choose a shop first." };
  }
  const locked = await featureProblem(orgId, "knowledge");
  if (locked) {
    return { ok: false, error: locked };
  }
  const file = form.get("audio");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose an audio file." };
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return { ok: false, error: "Recordings can be up to 25 MB." };
  }
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!AUDIO_TYPES.includes(ext)) {
    return { ok: false, error: `Audio files: ${AUDIO_TYPES.join(", ")}.` };
  }
  try {
    const result = await transcribeAudio(
      new Uint8Array(await file.arrayBuffer())
    );
    return result.text
      ? { ok: true, ...result }
      : { ok: false, error: "No speech found in that recording." };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Couldn't transcribe that.",
    };
  }
};

export const retryNote = async (noteId: string): Promise<Result> => {
  const { orgId } = await auth();
  if (!orgId) {
    return { ok: false, error: "Choose a shop first." };
  }
  const locked = await featureProblem(orgId, "knowledge");
  if (locked) {
    return { ok: false, error: locked };
  }
  const result = await rereadNote(orgId, noteId);
  refresh();
  return result
    ? { ok: true }
    : { ok: false, error: "That note was already read." };
};
