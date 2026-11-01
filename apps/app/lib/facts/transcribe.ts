import "server-only";

import { experimental_transcribe as transcribe } from "@repo/ai";
import { canEmbed, models } from "@repo/ai/lib/models";
import { database, forOrg } from "@repo/database";

/** Audio files a voice note can be uploaded as. */
export const AUDIO_TYPES = [".m4a", ".mp3", ".wav", ".webm", ".ogg", ".mp4"];
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// The same credentials as embeddings: Vertex AI, or an OpenAI key.
export const canTranscribe = () => canEmbed;

const MAX_PHRASES = 300;

/**
 * The shop's own words (part numbers, machines, customers, materials), so
 * speech-to-text writes "P-1001" and "HAAS-VF2" instead of what they sound like.
 */
export const shopVocabulary = async (orgId: string) => {
  const db = forOrg(database, orgId);
  const [machines, customers, materials, parts] = await Promise.all([
    db.workCenter.findMany({ select: { name: true }, take: 100 }),
    db.customer.findMany({ select: { name: true }, take: 100 }),
    db.material.findMany({ select: { name: true }, take: 50 }),
    db.part.findMany({
      select: { partNo: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
    }),
  ]);
  const phrases = [
    ...machines.map((m) => m.name),
    ...customers.map((c) => c.name),
    ...materials.map((m) => m.name),
    ...parts.map((p) => p.partNo),
  ].filter((p) => p.trim().length > 1);
  return [...new Set(phrases)].slice(0, MAX_PHRASES);
};

/** Speech to text for a recording, biased towards `vocabulary`. */
export const transcribeAudio = async (
  bytes: Uint8Array,
  vocabulary: string[] = []
) => {
  if (!canTranscribe()) {
    throw new Error(
      "Transcribing audio files isn't set up. Record in the browser instead, or type the note."
    );
  }
  const result = await transcribe({
    model: models.transcription,
    audio: bytes,
    providerOptions: {
      // Gemini: punctuated text, with the shop's terms spelled their way.
      vertex: {
        mode: "SMART",
        ...(vocabulary.length ? { customVocabulary: vocabulary } : {}),
      },
      // Whisper takes a hint as a prompt instead.
      ...(vocabulary.length
        ? { openai: { prompt: vocabulary.join(", ").slice(0, 800) } }
        : {}),
    },
  });
  return {
    text: result.text.trim(),
    durationSec: result.durationInSeconds ?? null,
  };
};
