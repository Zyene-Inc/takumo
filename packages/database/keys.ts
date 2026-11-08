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
      // Read-only login for Ask Takumo's SQL tool (role takumo_reader).
      ASK_DATABASE_URL: z.url().optional(),
      // Ask Takumo's SQL tool (query_data) runs only when this is exactly
      // "true" and the ask views are isolated (migration
      // 20261113100000_ask_view_isolation). Any other value means off; a
      // string, so a typo can't fail the app's start.
      ASK_SQL_ENABLED: z.string().optional(),
    },
    runtimeEnv: {
      DATABASE_URL: process.env.DATABASE_URL,
      DIRECT_URL: process.env.DIRECT_URL,
      ASK_DATABASE_URL: process.env.ASK_DATABASE_URL,
      ASK_SQL_ENABLED: process.env.ASK_SQL_ENABLED,
    },
  });
