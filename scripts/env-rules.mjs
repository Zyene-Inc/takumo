// What each deployed service needs before Takumo goes live (docs/LAUNCH.md).
// Pure data plus checks on a value's shape; values are never printed.

const https = (v) => v.startsWith("https://");
const usesVertex = (env) => env.GOOGLE_GENAI_USE_VERTEXAI?.trim() === "true";
const serviceAccount = (v) => {
  try {
    const key = JSON.parse(v);
    return typeof key.client_email === "string" &&
      typeof key.private_key === "string"
      ? null
      : "needs client_email and private_key";
  } catch {
    return "isn't valid JSON";
  }
};
const base64Key32 = (v) => {
  try {
    return Buffer.from(v, "base64").length === 32;
  } catch {
    return false;
  }
};

/**
 * Each variable: why it's needed, an optional check (value → problem or
 * null), and an optional skip (env → true when the setup doesn't use it).
 */
export const SERVICES = {
  app: {
    label: "takumo-app (apps/app)",
    required: {
      DATABASE_URL: { why: "database (pooled)" },
      WORKOS_API_KEY: {
        why: "sign-in",
        prod: (v) => (v.startsWith("sk_test_") ? "is a WorkOS test key" : null),
      },
      WORKOS_CLIENT_ID: { why: "sign-in" },
      WORKOS_COOKIE_PASSWORD: {
        why: "sessions",
        check: (v) => (v.length < 32 ? "must be at least 32 characters" : null),
      },
      NEXT_PUBLIC_WORKOS_REDIRECT_URI: {
        why: "sign-in callback",
        prod: (v) => (https(v) ? null : "must be https"),
      },
      NEXT_PUBLIC_APP_URL: {
        why: "links, OAuth and Stripe returns",
        prod: (v) => (https(v) ? null : "must be https"),
      },
      NEXT_PUBLIC_WEB_URL: { why: "marketing site links" },
      ANTHROPIC_API_KEY: {
        why: "Ask Takumo, RFQ reading, notes (or Gemini on Vertex AI)",
        check: (v) =>
          v.startsWith("sk-ant-") ? null : "doesn't look like an Anthropic key",
        skip: usesVertex,
      },
      GOOGLE_CLOUD_PROJECT: {
        why: "Gemini on Vertex AI",
        skip: (env) => !usesVertex(env),
      },
      GOOGLE_SERVICE_ACCOUNT_JSON: {
        why: "Gemini on Vertex AI",
        check: serviceAccount,
        skip: (env) => !usesVertex(env),
      },
      ASK_DATABASE_URL: { why: "Ask Takumo's read-only queries" },
      ENGINE_URL: {
        why: "scheduling, capacity, quotes",
        prod: (v) => (https(v) ? null : "must be https"),
      },
      ENGINE_SECRET: {
        why: "engine authentication",
        check: (v) =>
          v.length < 32 ? "should be at least 32 characters" : null,
      },
      CRON_SECRET: {
        why: "nightly recalibration, hourly connector sync",
        check: (v) => (v.length < 16 ? "must be at least 16 characters" : null),
      },
      STRIPE_SECRET_KEY: {
        why: "billing",
        prod: (v) =>
          v.startsWith("sk_live_") ? null : "is not a live Stripe key",
      },
      CONNECTOR_ENCRYPTION_KEY: {
        why: "QuickBooks and Gmail tokens",
        check: (v) => (base64Key32(v) ? null : "must be 32 bytes, base64"),
      },
      ADMIN_USER_IDS: { why: "/admin for Takumo staff" },
    },
    recommended: {
      NEXT_PUBLIC_POSTHOG_KEY: { why: "product analytics" },
      NEXT_PUBLIC_POSTHOG_HOST: { why: "product analytics" },
      NEXT_PUBLIC_SENTRY_DSN: { why: "error reports" },
      AI_MONTHLY_BUDGET_USD: { why: "caps Claude spend per shop per month" },
      QUICKBOOKS_CLIENT_ID: { why: "QuickBooks connector" },
      QUICKBOOKS_CLIENT_SECRET: { why: "QuickBooks connector" },
      QUICKBOOKS_ENVIRONMENT: {
        why: "QuickBooks connector",
        prod: (v) => (v === "production" ? null : "is not production"),
      },
      GOOGLE_CLIENT_ID: { why: "Gmail connector" },
      GOOGLE_CLIENT_SECRET: { why: "Gmail connector" },
      MICROSOFT_CLIENT_ID: { why: "Outlook connector" },
      MICROSOFT_CLIENT_SECRET: { why: "Outlook connector" },
      INBOUND_EMAIL_SECRET: {
        why: "ERP reports and RFQs by email (services/mail)",
        check: (v) =>
          v.length < 32 ? "should be at least 32 characters" : null,
      },
      INBOUND_EMAIL_DOMAIN: { why: "ERP reports and RFQs by email" },
      TWILIO_ACCOUNT_SID: {
        why: "notes by text (SMS / WhatsApp)",
        check: (v) => (v.startsWith("AC") ? null : "should start with AC"),
      },
      TWILIO_AUTH_TOKEN: { why: "notes by text (SMS / WhatsApp)" },
      TWILIO_SMS_FROM: {
        why: "notes by text: the shop number",
        check: (v) =>
          v.startsWith("+") ? null : "should be +<country><number>",
      },
      OPENAI_API_KEY: {
        why: "document vector search, audio-file transcription",
        skip: usesVertex,
      },
      // Off unless exactly "true"; set it only after the checks in
      // docs/DEPLOY.md step 1.3 pass on that environment's database.
      ASK_SQL_ENABLED: {
        why: "Ask Takumo's SQL tool (off until docs/DEPLOY.md step 1.3 passes)",
        check: (v) =>
          v === "true" || v === "false"
            ? null
            : 'must be "true" or "false" (anything else keeps it off)',
      },
    },
  },
  api: {
    label: "takumo-api (apps/api)",
    required: {
      DATABASE_URL: { why: "database" },
      WORKOS_API_KEY: { why: "shop and member sync" },
      WORKOS_CLIENT_ID: { why: "shop and member sync" },
      WORKOS_WEBHOOK_SECRET: { why: "WorkOS webhook signatures" },
      STRIPE_SECRET_KEY: {
        why: "billing webhook",
        prod: (v) =>
          v.startsWith("sk_live_") ? null : "is not a live Stripe key",
      },
      STRIPE_WEBHOOK_SECRET: {
        why: "Stripe webhook signatures",
        check: (v) =>
          v.startsWith("whsec_") ? null : "doesn't look like a webhook secret",
      },
      NEXT_PUBLIC_APP_URL: { why: "links" },
      NEXT_PUBLIC_WEB_URL: { why: "needed to build" },
    },
    recommended: {
      NEXT_PUBLIC_POSTHOG_KEY: { why: "subscription events" },
      NEXT_PUBLIC_POSTHOG_HOST: { why: "subscription events" },
      NEXT_PUBLIC_SENTRY_DSN: { why: "error reports" },
    },
  },
  web: {
    label: "takumo-web (apps/web)",
    required: {
      NEXT_PUBLIC_APP_URL: {
        why: "sign-in and sign-up links",
        prod: (v) => (https(v) ? null : "must be https"),
      },
      NEXT_PUBLIC_WEB_URL: {
        why: "canonical links",
        prod: (v) => (https(v) ? null : "must be https"),
      },
    },
    recommended: {
      NEXT_PUBLIC_POSTHOG_KEY: { why: "product analytics" },
      NEXT_PUBLIC_POSTHOG_HOST: { why: "product analytics" },
    },
  },
};

/** Problems with one service's environment: [{ name, level, problem, why }]. */
export const checkService = (service, env, { production = false } = {}) => {
  const out = [];
  for (const [level, vars] of [
    ["required", service.required],
    ["recommended", service.recommended],
  ]) {
    for (const [name, rule] of Object.entries(vars)) {
      if (rule.skip?.(env)) {
        continue;
      }
      const value = (env[name] ?? "").trim();
      if (!value) {
        out.push({ name, level, problem: "not set", why: rule.why });
        continue;
      }
      const problem =
        rule.check?.(value) ?? (production ? rule.prod?.(value) : null) ?? null;
      if (problem) {
        out.push({ name, level, problem, why: rule.why });
      }
    }
  }
  return out;
};
