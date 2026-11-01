import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/** A service account key file's contents, pasted as one value. */
const serviceAccountJson = z.string().refine((v) => {
  try {
    const key = JSON.parse(v) as Record<string, unknown>;
    return (
      typeof key.client_email === "string" &&
      typeof key.private_key === "string"
    );
  } catch {
    return false;
  }
}, "must be a Google service account key (JSON with client_email and private_key)");

export const keys = () =>
  createEnv({
    skipValidation: process.env.SKIP_ENV_VALIDATION === "true",
    emptyStringAsUndefined: true,
    server: {
      ANTHROPIC_API_KEY: z.string().startsWith("sk-ant-").optional(),
      // Optional: document embeddings and voice-note transcription.
      OPENAI_API_KEY: z.string().startsWith("sk-").optional(),
      // Gemini on Google Cloud Vertex AI instead of Claude and OpenAI.
      GOOGLE_GENAI_USE_VERTEXAI: z.enum(["true", "false"]).optional(),
      GOOGLE_CLOUD_PROJECT: z.string().optional(),
      GOOGLE_CLOUD_LOCATION: z.string().optional(),
      GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccountJson.optional(),
    },
    runtimeEnv: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GOOGLE_GENAI_USE_VERTEXAI: process.env.GOOGLE_GENAI_USE_VERTEXAI,
      GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
      GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION,
      GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    },
  });
