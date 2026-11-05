import { createAnthropic } from "@ai-sdk/anthropic";
import { createVertex } from "@ai-sdk/google-vertex";
import { createOpenAI } from "@ai-sdk/openai";
import type {
  EmbeddingModel,
  LanguageModel,
  ProviderMetadata,
  TranscriptionModel,
} from "ai";
import { keys } from "../keys";

const EMBEDDING_DIMENSIONS = 1024;

const env = keys();

/**
 * Gemini on Vertex AI when GOOGLE_GENAI_USE_VERTEXAI=true and the project and
 * service account are set; Claude (plus OpenAI for embeddings and audio)
 * otherwise. Unsetting the flag switches back without a code change.
 */
const usesVertex = Boolean(
  env.GOOGLE_GENAI_USE_VERTEXAI === "true" &&
    env.GOOGLE_CLOUD_PROJECT &&
    env.GOOGLE_SERVICE_ACCOUNT_JSON
);

interface Models {
  agent: LanguageModel;
  chat: LanguageModel;
  embeddings: EmbeddingModel;
  extract: LanguageModel;
  transcription: TranscriptionModel;
}

const vertexModels = (): Models => {
  const vertex = createVertex({
    project: env.GOOGLE_CLOUD_PROJECT,
    location: env.GOOGLE_CLOUD_LOCATION ?? "global",
    googleAuthOptions: {
      credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "{}"),
    },
  });
  return {
    agent: vertex("gemini-4-argon"),
    chat: vertex("gemini-3.8-flash"),
    extract: vertex("gemini-3.5-flash-lite"),
    embeddings: vertex.textEmbeddingModel("gemini-embedding-001"),
    transcription: vertex.transcription("gemini-3.5-transcribe"),
  };
};

const claudeModels = (): Models => {
  const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
  return {
    agent: anthropic("claude-opus-5-5"),
    chat: anthropic("claude-sonnet-5-5"),
    extract: anthropic("claude-haiku-5-5"),
    embeddings: openai.textEmbeddingModel("text-embedding-3-small"),
    transcription: openai.transcription("whisper-1"),
  };
};

// See docs/TAKUMO.md section 7. The agent never computes numbers itself:
// it calls engine tools and explains their results with citations.
//   agent: multi-step planning (capacity questions, quote reasoning)
//   chat: most chat turns
//   extract: bulk work (column mapping, RFQ field extraction, summaries)
//   embeddings: document vectors, DocChunk.embedding vector(1024)
//   transcription: voice notes uploaded as audio files (recordings made in
//     the browser are transcribed by the browser instead)
export const models: Models = usesVertex ? vertexModels() : claudeModels();

/** Whether the language models have credentials. */
export const canGenerate = usesVertex || Boolean(env.ANTHROPIC_API_KEY);

/** Whether embeddings and audio-file transcription have credentials. */
export const canEmbed = usesVertex || Boolean(env.OPENAI_API_KEY);

/** Options for embed/embedMany, so vectors fit DocChunk.embedding. */
export const embeddingOptions = (
  use: "document" | "query"
): { providerOptions: ProviderMetadata } => ({
  providerOptions: usesVertex
    ? {
        vertex: {
          outputDimensionality: EMBEDDING_DIMENSIONS,
          taskType:
            use === "document" ? "RETRIEVAL_DOCUMENT" : "RETRIEVAL_QUERY",
        },
      }
    : { openai: { dimensions: EMBEDDING_DIMENSIONS } },
});
