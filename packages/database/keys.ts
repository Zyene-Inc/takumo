import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const keys = () =>
  createEnv({
    skipValidation: process.env.SKIP_ENV_VALIDATION === "true",
    emptyStringAsUndefined: true,
    server: {
      // Pooled connection (Supabase transaction pooler, port 6543) for the app.
      DATABASE_URL: z.url(),
      // Direct connection (port 5432) for migrations. Falls back to DATABASE_URL.
      DIRECT_URL: z.url().optional(),
    },
    runtimeEnv: {
      DATABASE_URL: process.env.DATABASE_URL,
      DIRECT_URL: process.env.DIRECT_URL,
    },
  });
