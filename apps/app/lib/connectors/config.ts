import "server-only";

import { env } from "@/env";
import { parseKey } from "./crypto";

export const PROVIDERS = ["quickbooks", "gmail", "outlook"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_NAME: Record<Provider, string> = {
  quickbooks: "QuickBooks",
  gmail: "Gmail",
  outlook: "Outlook",
};

export const redirectUri = (provider: Provider) =>
  `${env.NEXT_PUBLIC_APP_URL}/api/connectors/${provider}/callback`;

/** Where Microsoft sends a shop's IT person after approving Takumo. */
export const adminConsentRedirectUri = () =>
  `${env.NEXT_PUBLIC_APP_URL}/api/connectors/outlook/admin-consent`;

/**
 * Where Microsoft Graph posts new-mail notifications. Graph only accepts
 * HTTPS, so local development falls back to the hourly check.
 */
export const outlookNotificationUrl = () =>
  env.NEXT_PUBLIC_APP_URL.startsWith("https://")
    ? `${env.NEXT_PUBLIC_APP_URL}/api/connectors/outlook/notify`
    : null;

export const encryptionKey = () => parseKey(env.CONNECTOR_ENCRYPTION_KEY);

/** OAuth app credentials, or null when the provider isn't set up. */
export const credentials = (provider: Provider) => {
  if (!env.CONNECTOR_ENCRYPTION_KEY) {
    return null;
  }
  if (provider === "quickbooks") {
    return env.QUICKBOOKS_CLIENT_ID && env.QUICKBOOKS_CLIENT_SECRET
      ? {
          clientId: env.QUICKBOOKS_CLIENT_ID,
          clientSecret: env.QUICKBOOKS_CLIENT_SECRET,
          redirectUri: redirectUri(provider),
          environment: env.QUICKBOOKS_ENVIRONMENT ?? "sandbox",
        }
      : null;
  }
  if (provider === "outlook") {
    return env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
      ? {
          clientId: env.MICROSOFT_CLIENT_ID,
          clientSecret: env.MICROSOFT_CLIENT_SECRET,
          redirectUri: redirectUri(provider),
          environment: "production" as const,
        }
      : null;
  }
  return env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUri: redirectUri(provider),
        environment: "production" as const,
      }
    : null;
};
