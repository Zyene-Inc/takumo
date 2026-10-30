import "server-only";

import { experimental_transcribe as transcribe } from "@repo/ai";
import { keys } from "@repo/ai/keys";
import { models } from "@repo/ai/lib/models";

/** Audio files a voice note can be uploaded as. */
export const AUDIO_TYPES = [".m4a", ".mp3", ".wav", ".webm", ".ogg", ".mp4"];
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export const canTranscribe = () => Boolean(keys().OPENAI_API_KEY);

/** Speech to text for an uploaded recording. */
export const transcribeAudio = async (bytes: Uint8Array) => {
  if (!canTranscribe()) {
    throw new Error(
      "Transcribing audio files needs OPENAI_API_KEY. Record in the browser instead, or type the note."
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
