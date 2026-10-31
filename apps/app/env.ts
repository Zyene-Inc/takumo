import { keys as analytics } from "@repo/analytics/keys";
import { keys as auth } from "@repo/auth/keys";
import { keys as database } from "@repo/database/keys";
import { keys as email } from "@repo/email/keys";
import { keys as engine } from "@repo/engine-client/keys";
import { keys as flags } from "@repo/feature-flags/keys";
import { keys as core } from "@repo/next-config/keys";
import { keys as observability } from "@repo/observability/keys";
import { keys as security } from "@repo/security/keys";
import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  skipValidation: process.env.SKIP_ENV_VALIDATION === "true",
  emptyStringAsUndefined: true,
  extends: [
    auth(),
    analytics(),
    core(),
    database(),
    email(),
    engine(),
    flags(),
    observability(),
    security(),
  ],
  server: {
    // Vercel sends it as a bearer token to cron routes (vercel.json).
    CRON_SECRET: z.string().min(16).optional(),
    // Connectors (docs/DEPLOY.md): tokens are encrypted with this key.
    CONNECTOR_ENCRYPTION_KEY: z.string().min(40).optional(),
    QUICKBOOKS_CLIENT_ID: z.string().min(1).optional(),
    QUICKBOOKS_CLIENT_SECRET: z.string().min(1).optional(),
    QUICKBOOKS_ENVIRONMENT: z.enum(["sandbox", "production"]).optional(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    // Takumo staff (WorkOS user ids, comma separated) who can see /admin.
    ADMIN_USER_IDS: z.string().optional(),
    // Claude spend cap per shop per month, in USD (unset = no cap).
    AI_MONTHLY_BUDGET_USD: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  },
  client: {},
  runtimeEnv: {
    CRON_SECRET: process.env.CRON_SECRET,
    CONNECTOR_ENCRYPTION_KEY: process.env.CONNECTOR_ENCRYPTION_KEY,
    QUICKBOOKS_CLIENT_ID: process.env.QUICKBOOKS_CLIENT_ID,
    QUICKBOOKS_CLIENT_SECRET: process.env.QUICKBOOKS_CLIENT_SECRET,
    QUICKBOOKS_ENVIRONMENT: process.env.QUICKBOOKS_ENVIRONMENT,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    ADMIN_USER_IDS: process.env.ADMIN_USER_IDS,
    AI_MONTHLY_BUDGET_USD: process.env.AI_MONTHLY_BUDGET_USD,
  },
});
