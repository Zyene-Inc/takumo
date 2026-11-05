import { keys as analytics } from "@repo/analytics/keys";
import { keys as auth } from "@repo/auth/keys";
import { keys as database } from "@repo/database/keys";
import { keys as email } from "@repo/email/keys";
import { keys as engine } from "@repo/engine-client/keys";
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
    // Outlook / Microsoft 365 connector: a multi-tenant Entra app.
    MICROSOFT_CLIENT_ID: z.string().min(1).optional(),
    MICROSOFT_CLIENT_SECRET: z.string().min(1).optional(),
    // Inbound email (services/mail → /api/inbound/email): the shared secret
    // the mail receiver signs with, and the domain shops' addresses live on.
    INBOUND_EMAIL_SECRET: z.string().min(32).optional(),
    INBOUND_EMAIL_DOMAIN: z.string().min(3).optional(),
    // Signs the links in emails (brief approve buttons, unsubscribe, link
    // clicks). Without it the brief and alerts go out with plain app links.
    EMAIL_LINK_SECRET: z.string().min(32).optional(),
    // Notes by text message (F6.1, docs/DEPLOY.md): the shop number's
    // Twilio account, the numbers it sends from, and (optional) the exact
    // public URL Twilio posts to, which its signatures are computed over.
    TWILIO_ACCOUNT_SID: z.string().startsWith("AC").optional(),
    TWILIO_AUTH_TOKEN: z.string().min(16).optional(),
    TWILIO_SMS_FROM: z.string().min(4).optional(),
    TWILIO_WHATSAPP_FROM: z.string().min(4).optional(),
    TWILIO_WEBHOOK_URL: z.url().optional(),
    // Takumo staff (WorkOS user ids, comma separated) who can see /admin.
    ADMIN_USER_IDS: z.string().optional(),
    // Claude spend cap per shop per month, in USD (unset = no cap).
    AI_MONTHLY_BUDGET_USD: z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .optional(),
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
    MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET,
    INBOUND_EMAIL_SECRET: process.env.INBOUND_EMAIL_SECRET,
    INBOUND_EMAIL_DOMAIN: process.env.INBOUND_EMAIL_DOMAIN,
    EMAIL_LINK_SECRET: process.env.EMAIL_LINK_SECRET,
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    TWILIO_SMS_FROM: process.env.TWILIO_SMS_FROM,
    TWILIO_WHATSAPP_FROM: process.env.TWILIO_WHATSAPP_FROM,
    TWILIO_WEBHOOK_URL: process.env.TWILIO_WEBHOOK_URL,
    ADMIN_USER_IDS: process.env.ADMIN_USER_IDS,
    AI_MONTHLY_BUDGET_USD: process.env.AI_MONTHLY_BUDGET_USD,
  },
});
