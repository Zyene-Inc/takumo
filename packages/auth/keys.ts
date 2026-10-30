import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

// WorkOS AuthKit. Values come from https://dashboard.workos.com.
// The AuthKit SDK reads these from process.env itself; this validates them.
export const keys = () =>
  createEnv({
    skipValidation: process.env.SKIP_ENV_VALIDATION === "true",
    emptyStringAsUndefined: true,
    server: {
      WORKOS_API_KEY: z.string().startsWith("sk_").optional(),
      WORKOS_CLIENT_ID: z.string().startsWith("client_").optional(),
      // Encrypts the session cookie; at least 32 characters.
      WORKOS_COOKIE_PASSWORD: z.string().min(32).optional(),
      WORKOS_WEBHOOK_SECRET: z.string().optional(),
    },
    client: {
      NEXT_PUBLIC_WORKOS_REDIRECT_URI: z.url().optional(),
    },
    runtimeEnv: {
      WORKOS_API_KEY: process.env.WORKOS_API_KEY,
      WORKOS_CLIENT_ID: process.env.WORKOS_CLIENT_ID,
      WORKOS_COOKIE_PASSWORD: process.env.WORKOS_COOKIE_PASSWORD,
      WORKOS_WEBHOOK_SECRET: process.env.WORKOS_WEBHOOK_SECRET,
      NEXT_PUBLIC_WORKOS_REDIRECT_URI:
        process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI,
    },
  });
