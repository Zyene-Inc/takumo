import "server-only";

import { experimental_transcribe as transcribe } from "@repo/ai";
import { canEmbed, models } from "@repo/ai/lib/models";

/** Audio files a voice note can be uploaded as. */
export const AUDIO_TYPES = [".m4a", ".mp3", ".wav", ".webm", ".ogg", ".mp4"];
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// The same credentials as embeddings: Vertex AI, or an OpenAI key.
export const canTranscribe = () => canEmbed;

/** Speech to text for an uploaded recording. */
export const transcribeAudio = async (bytes: Uint8Array) => {
  if (!canTranscribe()) {
    throw new Error(
      "Transcribing audio files needs Gemini on Vertex AI or OPENAI_API_KEY. Record in the browser instead, or type the note."
    );
  }
  const result = await transcribe({
    model: models.transcription,
    audio: bytes,
  });
  return {
    text: result.text.trim(),
    durationSec: result.durationInSeconds ?? null,
  };
};
