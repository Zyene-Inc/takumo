// Microsoft Graph basics: endpoints, scopes, token and error types, and the request helper.

export const LOGIN = "https://login.microsoftonline.com";

// "common" picks the person's own tenant; the app registration allows work or
// school accounts only, so Microsoft refuses personal accounts itself.
export const MS_AUTHORIZE_URL = `${LOGIN}/common/oauth2/v2.0/authorize`;

export const MS_TOKEN_URL = `${LOGIN}/common/oauth2/v2.0/token`;

// Admin consent can't use "common"; "organizations" lets any tenant's admin.
export const MS_ADMIN_CONSENT_URL = `${LOGIN}/organizations/v2.0/adminconsent`;

export const GRAPH_API = "https://graph.microsoft.com/v1.0";

export const GRAPH = "https://graph.microsoft.com/";

/**
 * Delegated permissions. Mail.ReadWrite.Shared covers an optional shared RFQ
 * mailbox; like Mail.ReadWrite it doesn't need an admin unless the tenant
 * blocks user consent, so it's asked for up front instead of a second sign-in.
 */
export const OUTLOOK_SCOPES = [
  "offline_access",
  `${GRAPH}User.Read`,
  `${GRAPH}Mail.ReadWrite`,
  `${GRAPH}Mail.ReadWrite.Shared`,
];

/** Messages read into RFQs per check (the rest wait for the next one). */
export const MAX_MESSAGES = 20;

/** Delta pages per check; 100 × 50 covers the 5,000 a filtered delta returns. */
export const MAX_PAGES = 100;

export const PAGE_SIZE = 50;

/**
 * Outlook message subscriptions last under 7 days (10,080 minutes); ask for a
 * little less so a renewal is never refused for running long.
 */
export const SUBSCRIPTION_MINUTES = 10_000;

/** Renew when a subscription has less than this left (the cron is hourly). */
export const RENEW_WITHIN_MS = 24 * 60 * 60_000;

export type Fetch = typeof fetch;

export interface MicrosoftTokens {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/** Access is gone (expired, revoked, or consent withdrawn): reconnect. */
export class OutlookAuthError extends Error {}

/** The tenant needs an administrator to approve Takumo first. */
export class OutlookConsentError extends Error {}

/** The shared mailbox doesn't exist or this person can't open it. */
export class OutlookMailboxError extends Error {}

/** A saved delta link Graph no longer accepts: start a fresh round. */
export class OutlookDeltaExpired extends Error {}

/** "/me", or the shared mailbox (by address) the shop reads RFQs from. */
export const mailboxPath = (sharedMailbox?: string | null) =>
  sharedMailbox ? `/users/${encodeURIComponent(sharedMailbox)}` : "/me";

export interface GraphInit {
  body?: string;
  headers?: Record<string, string>;
  method?: "DELETE" | "PATCH" | "POST";
  sharedMailbox?: string | null;
}

// Ids that survive a message being moved to another folder, so de-duplication
// by message id still holds when someone files the RFQ.
export const IMMUTABLE_IDS = 'IdType="ImmutableId"';

export const graph = async (
  fetcher: Fetch,
  accessToken: string,
  url: string,
  init: GraphInit = {}
) => {
  const response = await fetcher(
    url.startsWith("https://") ? url : `${GRAPH_API}${url}`,
    {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: IMMUTABLE_IDS,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      ...(init.body ? { body: init.body } : {}),
    }
  );
  if (response.status === 401) {
    throw new OutlookAuthError("Outlook access expired. Reconnect it.");
  }
  if (
    init.sharedMailbox &&
    (response.status === 403 || response.status === 404)
  ) {
    throw new OutlookMailboxError(
      `Takumo can't open the shared mailbox ${init.sharedMailbox}. Ask your IT person to give the connected account Full Access to it, or clear the shared mailbox.`
    );
  }
  return response;
};

export const json = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    throw new Error(`Microsoft Graph returned an error (${response.status}).`);
  }
  return (await response.json()) as T;
};
