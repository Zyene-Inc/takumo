import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const keys = () =>
  createEnv({
    skipValidation: process.env.SKIP_ENV_VALIDATION === "true",
    emptyStringAsUndefined: true,
    server: {
      ENGINE_URL: z.url().default("http://localhost:8000"),
      ENGINE_SECRET: z.string().optional(),
    },
    runtimeEnv: {
      ENGINE_URL: process.env.ENGINE_URL,
      ENGINE_SECRET: process.env.ENGINE_SECRET,
    },
  });
