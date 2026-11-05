// Outlook sign-in: PKCE, admin consent and token exchange.

import { createHash, createHmac } from "node:crypto";
import {
  type Fetch,
  GRAPH,
  type MicrosoftTokens,
  MS_ADMIN_CONSENT_URL,
  MS_AUTHORIZE_URL,
  MS_TOKEN_URL,
  OUTLOOK_SCOPES,
  OutlookAuthError,
  OutlookConsentError,
} from "./graph";

// PKCE without storing anything: the verifier is derived from the signed
// state, which comes back on the callback.
export const pkceVerifier = (key: Buffer, state: string) =>
  createHmac("sha256", key).update(`pkce.${state}`).digest("base64url");

export const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

export const authorizeUrl = (
  clientId: string,
  redirectUri: string,
  state: string,
  verifier: string
) => {
  const url = new URL(MS_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: OUTLOOK_SCOPES.join(" "),
    state,
    // Let the person pick the work account that owns the RFQ mailbox.
    prompt: "select_account",
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
};

/**
 * Where the shop's IT person approves Takumo for the whole organization, when
 * the tenant doesn't let people approve apps themselves.
 */
export const adminConsentUrl = (clientId: string, redirectUri: string) => {
  const url = new URL(MS_ADMIN_CONSENT_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    scope: OUTLOOK_SCOPES.join(" "),
    redirect_uri: redirectUri,
  }).toString();
  return url.toString();
};

// AADSTS65001: no consent yet; 90094 / 90095: the tenant requires an admin
// (or an admin-approval request); 65004 is a person declining, not a block.
export const ADMIN_CODES = /AADSTS(65001|90094|90095|90008)\b/;

export const ADMIN_WORDS = /admin(istrator)? (approval|consent)/i;

export const SPACES = /\s+/;

export const MILLISECONDS = /\.\d{3}Z$/;

export const SINGLE_QUOTE = /'/g;

/** Whether a sign-in error means an administrator has to approve Takumo. */
export const needsAdminConsent = (
  error: string | null | undefined,
  description: string | null | undefined
) =>
  error === "consent_required" ||
  ADMIN_CODES.test(description ?? "") ||
  ADMIN_WORDS.test(description ?? "");

export const tokenRequest = async (
  fetcher: Fetch,
  body: Record<string, string>
) => {
  const response = await fetcher(MS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };
    if (needsAdminConsent(failure.error, failure.error_description)) {
      throw new OutlookConsentError(
        "Your organization needs an administrator to approve Takumo first."
      );
    }
    throw new OutlookAuthError(
      `Microsoft refused the sign-in (${response.status}${failure.error ? `, ${failure.error}` : ""}).`
    );
  }
  return (await response.json()) as MicrosoftTokens;
};

export const exchangeCode = (
  fetcher: Fetch,
  creds: { clientId: string; clientSecret: string; redirectUri: string },
  code: string,
  verifier: string
) =>
  tokenRequest(fetcher, {
    grant_type: "authorization_code",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: creds.redirectUri,
    code,
    code_verifier: verifier,
    scope: OUTLOOK_SCOPES.join(" "),
  });

/** Microsoft sends a new refresh token each time; keep the newest. */
export const refreshTokens = (
  fetcher: Fetch,
  creds: { clientId: string; clientSecret: string },
  refreshToken: string
) =>
  tokenRequest(fetcher, {
    grant_type: "refresh_token",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: refreshToken,
    scope: OUTLOOK_SCOPES.join(" "),
  });

/** The granted scopes, short and lower case ("mail.readwrite"). */
export const grantedScopes = (scope: string | null | undefined) =>
  decodeURIComponent(scope ?? "")
    .split(SPACES)
    .filter(Boolean)
    .map((s) => s.replace(GRAPH, "").toLowerCase());

/** Whether the person allowed reading mail (the one permission required). */
export const canReadMail = (scope: string | null | undefined) =>
  grantedScopes(scope).includes("mail.readwrite");
