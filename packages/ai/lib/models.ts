import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { EmbeddingModel, LanguageModel, TranscriptionModel } from "ai";
import { keys } from "../keys";

const anthropic = createAnthropic({
  apiKey: keys().ANTHROPIC_API_KEY,
});

const openai = createOpenAI({
  apiKey: keys().OPENAI_API_KEY,
});

// See docs/TAKUMO.md section 7. The agent never computes numbers itself:
// it calls engine tools and explains their results with citations.
export const models: {
  agent: LanguageModel;
  chat: LanguageModel;
  extract: LanguageModel;
  embeddings: EmbeddingModel;
  transcription: TranscriptionModel;
} = {
  // Multi-step planning: capacity questions, quote reasoning.
  agent: anthropic("claude-opus-5-5"),
  // Most chat turns.
  chat: anthropic("claude-sonnet-5-5"),
  // Bulk work: column mapping, RFQ field extraction, summaries.
  extract: anthropic("claude-haiku-5-5"),
  // Call with providerOptions: { openai: { dimensions: EMBEDDING_DIMENSIONS } }
  // so vectors match DocChunk.embedding vector(1024).
  embeddings: openai.textEmbeddingModel("text-embedding-3-small"),
  // Voice notes uploaded as audio files (needs OPENAI_API_KEY; recordings
  // made in the browser are transcribed by the browser instead).
  transcription: openai.transcription("whisper-1"),
};

export const EMBEDDING_DIMENSIONS = 1024;
