// Gmail as the RFQ inbox: OAuth 2.0, and new messages that look like requests
// for quote. Each becomes an RFQ, read the same way as an uploaded .eml
// (attachments included). Compose permission lets Takumo leave a reply draft
// in the RFQ's thread; it never sends. HTTP calls take `fetch`, so tested
// without the network.

import { gmailSubjectQuery } from "./rfq-rules";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
/** Create drafts (never send): for reply drafts in the RFQ's thread. */
export const GMAIL_COMPOSE_SCOPE =
  "https://www.googleapis.com/auth/gmail.compose";
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** What counts as an RFQ unless the shop sets its own Gmail search. */
export const DEFAULT_RFQ_QUERY = gmailSubjectQuery();
export const authorizeUrl = (
  clientId: string,
  redirectUri: string,
  state: string
) => {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: `${GMAIL_SCOPE} ${GMAIL_COMPOSE_SCOPE} email`,
    access_type: "offline",
    // Ask again so Google returns a refresh token on reconnect.
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  }).toString();
  return url.toString();
};

/** The Gmail search for new RFQs since a moment (seconds since epoch). */
export const searchFor = (query: string | null | undefined, since: Date) =>
  `${(query?.trim() || DEFAULT_RFQ_QUERY).slice(0, 500)} after:${Math.floor(since.getTime() / 1000)}`;

export type Fetch = typeof fetch;

interface GoogleTokens {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export class GmailAuthError extends Error {}

const SPACES = /\s+/;

/** Whether a connection was granted before Takumo asked to write drafts. */
export const canDraft = (scope: string | null | undefined) =>
  (scope ?? "").split(SPACES).includes(GMAIL_COMPOSE_SCOPE);

const tokenRequest = async (fetcher: Fetch, body: Record<string, string>) => {
  const response = await fetcher(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!response.ok) {
    throw new GmailAuthError(
      `Google refused the sign-in (${response.status}).`
    );
  }
  return (await response.json()) as GoogleTokens;
};

export const exchangeCode = (
  fetcher: Fetch,
  creds: { clientId: string; clientSecret: string; redirectUri: string },
  code: string
) =>
  tokenRequest(fetcher, {
    grant_type: "authorization_code",
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: creds.redirectUri,
  });

export const refreshTokens = (
  fetcher: Fetch,
  creds: { clientId: string; clientSecret: string },
  refreshToken: string
) =>
  tokenRequest(fetcher, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });

export const revokeToken = async (fetcher: Fetch, token: string) => {
  await fetcher(`${GOOGLE_REVOKE_URL}?${new URLSearchParams({ token })}`, {
    method: "POST",
  });
};

export const get = async <T>(
  fetcher: Fetch,
  accessToken: string,
  path: string,
  init?: { body: string; method: "POST" }
): Promise<T> => {
  const response = await fetcher(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (response.status === 401) {
    throw new GmailAuthError("Gmail access expired. Reconnect it.");
  }
  if (!response.ok) {
    throw new Error(`Gmail returned an error (${response.status}).`);
  }
  return (await response.json()) as T;
};

export const mailbox = async (fetcher: Fetch, accessToken: string) =>
  (await get<{ emailAddress: string }>(fetcher, accessToken, "/profile"))
    .emailAddress;
