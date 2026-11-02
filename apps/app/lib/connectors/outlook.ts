// Outlook (Microsoft 365) as the RFQ inbox: OAuth 2.0 with a multi-tenant
// Entra app, new Inbox mail through Microsoft Graph delta queries, and change
// notifications so an RFQ shows up within a minute or two instead of at the
// next hourly check. Each RFQ is read from its MIME (.eml) like an upload.
// Mail.ReadWrite is only for leaving reply drafts later; Takumo never sends.
// HTTP calls take `fetch`, so tested without the network.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isRfqSubject, type PreviewMessage } from "./rfq-rules";

const LOGIN = "https://login.microsoftonline.com";
// "common" picks the person's own tenant; the app registration allows work or
// school accounts only, so Microsoft refuses personal accounts itself.
export const MS_AUTHORIZE_URL = `${LOGIN}/common/oauth2/v2.0/authorize`;
export const MS_TOKEN_URL = `${LOGIN}/common/oauth2/v2.0/token`;
// Admin consent can't use "common"; "organizations" lets any tenant's admin.
export const MS_ADMIN_CONSENT_URL = `${LOGIN}/organizations/v2.0/adminconsent`;
export const GRAPH_API = "https://graph.microsoft.com/v1.0";

const GRAPH = "https://graph.microsoft.com/";
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
const MAX_PAGES = 100;
const PAGE_SIZE = 50;
/**
 * Outlook message subscriptions last under 7 days (10,080 minutes); ask for a
 * little less so a renewal is never refused for running long.
 */
export const SUBSCRIPTION_MINUTES = 10_000;
/** Renew when a subscription has less than this left (the cron is hourly). */
export const RENEW_WITHIN_MS = 24 * 60 * 60_000;

type Fetch = typeof fetch;

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

// PKCE without storing anything: the verifier is derived from the signed
// state, which comes back on the callback.
export const pkceVerifier = (key: Buffer, state: string) =>
  createHmac("sha256", key).update(`pkce.${state}`).digest("base64url");

const pkceChallenge = (verifier: string) =>
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
const ADMIN_CODES = /AADSTS(65001|90094|90095|90008)\b/;
const ADMIN_WORDS = /admin(istrator)? (approval|consent)/i;
const SPACES = /\s+/;
const MILLISECONDS = /\.\d{3}Z$/;

/** Whether a sign-in error means an administrator has to approve Takumo. */
export const needsAdminConsent = (
  error: string | null | undefined,
  description: string | null | undefined
) =>
  error === "consent_required" ||
  ADMIN_CODES.test(description ?? "") ||
  ADMIN_WORDS.test(description ?? "");

const tokenRequest = async (fetcher: Fetch, body: Record<string, string>) => {
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

/** "/me", or the shared mailbox (by address) the shop reads RFQs from. */
export const mailboxPath = (sharedMailbox?: string | null) =>
  sharedMailbox ? `/users/${encodeURIComponent(sharedMailbox)}` : "/me";

interface GraphInit {
  body?: string;
  headers?: Record<string, string>;
  method?: "DELETE" | "PATCH" | "POST";
  sharedMailbox?: string | null;
}

// Ids that survive a message being moved to another folder, so de-duplication
// by message id still holds when someone files the RFQ.
const IMMUTABLE_IDS = 'IdType="ImmutableId"';

const graph = async (
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

const json = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    throw new Error(`Microsoft Graph returned an error (${response.status}).`);
  }
  return (await response.json()) as T;
};

/** The signed-in mailbox's address (work accounts may have only a UPN). */
export const mailbox = async (fetcher: Fetch, accessToken: string) => {
  const me = await json<{ mail?: string | null; userPrincipalName?: string }>(
    await graph(
      fetcher,
      accessToken,
      "/me?$select=mail,userPrincipalName,displayName"
    )
  );
  const address = me.mail || me.userPrincipalName;
  if (!address) {
    throw new Error("This Microsoft account has no mailbox.");
  }
  return address;
};

export interface GraphMessage {
  "@removed"?: { reason: string };
  conversationId?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  hasAttachments?: boolean;
  id: string;
  isDraft?: boolean;
  receivedDateTime?: string;
  subject?: string | null;
}

const SELECT =
  "subject,from,receivedDateTime,hasAttachments,isDraft,conversationId";

// Graph wants "$select", not "%24select"; values are still encoded.
const query = (params: Record<string, string>) =>
  Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

/**
 * The first delta request for the Inbox: only newly created mail from here
 * on, starting with what arrived since `since`.
 */
export const firstDeltaUrl = (
  sharedMailbox: string | null | undefined,
  since: Date
) =>
  `${GRAPH_API}${mailboxPath(sharedMailbox)}/mailFolders/inbox/messages/delta?${query(
    {
      changeType: "created",
      $select: SELECT,
      $filter: `receivedDateTime ge ${since.toISOString().replace(MILLISECONDS, "Z")}`,
    }
  )}`;

/**
 * One round of a delta query: every page (following @odata.nextLink) until
 * Graph hands back the @odata.deltaLink to start from next time.
 */
export const readDelta = async (
  fetcher: Fetch,
  accessToken: string,
  url: string,
  sharedMailbox?: string | null
) => {
  const messages: GraphMessage[] = [];
  let next: string | undefined = url;
  for (let page = 0; next && page < MAX_PAGES; page += 1) {
    const response = await graph(fetcher, accessToken, next, {
      sharedMailbox,
      headers: { Prefer: `odata.maxpagesize=${PAGE_SIZE}, ${IMMUTABLE_IDS}` },
    });
    if (response.status === 410) {
      throw new OutlookDeltaExpired("The saved Outlook position expired.");
    }
    const body = await json<{
      "@odata.deltaLink"?: string;
      "@odata.nextLink"?: string;
      value?: GraphMessage[];
    }>(response);
    // Deleted or moved-away messages show up as "@removed": nothing to read.
    messages.push(...(body.value ?? []).filter((m) => !m["@removed"]));
    if (body["@odata.deltaLink"]) {
      return { messages, deltaLink: body["@odata.deltaLink"] };
    }
    next = body["@odata.nextLink"];
  }
  // Ran out of pages before the round finished: keep the old position.
  return { messages, deltaLink: null };
};

/**
 * The messages to read into RFQs, oldest first: RFQ subjects only, no drafts,
 * nothing the mailbox itself sent.
 */
export const rfqMessages = (messages: GraphMessage[], ownAddress: string) =>
  messages
    .filter(
      (m) =>
        !m.isDraft &&
        isRfqSubject(m.subject) &&
        m.from?.emailAddress?.address?.toLowerCase() !==
          ownAddress.toLowerCase()
    )
    .sort((a, b) =>
      (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? "")
    );

/** The message as an .eml file (its MIME content). */
export const rawMessage = async (
  fetcher: Fetch,
  accessToken: string,
  id: string,
  sharedMailbox?: string | null
) => {
  const response = await graph(
    fetcher,
    accessToken,
    `${mailboxPath(sharedMailbox)}/messages/${encodeURIComponent(id)}/$value`
  );
  if (!response.ok) {
    throw new Error(`Outlook returned an error (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
};

/** The last 20 Inbox emails, each marked whether it would become an RFQ. */
export const previewMessages = async (
  fetcher: Fetch,
  accessToken: string,
  ownAddress: string,
  sharedMailbox?: string | null
): Promise<PreviewMessage[]> => {
  const { value } = await json<{ value?: GraphMessage[] }>(
    await graph(
      fetcher,
      accessToken,
      `${mailboxPath(sharedMailbox)}/mailFolders/inbox/messages?${query({
        $select: SELECT,
        $orderby: "receivedDateTime desc",
        $top: String(MAX_MESSAGES),
      })}`,
      { sharedMailbox }
    )
  );
  const rfqs = new Set(rfqMessages(value ?? [], ownAddress).map((m) => m.id));
  return (value ?? []).map((m) => ({
    id: m.id,
    subject: m.subject ?? null,
    from: m.from?.emailAddress?.address ?? null,
    receivedAt: m.receivedDateTime ?? null,
    isRfq: rfqs.has(m.id),
  }));
};

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c
  );

/**
 * A reply draft to the RFQ, left in the mailbox's Drafts for the estimator to
 * review and send: createReply (which threads it and quotes the original),
 * then our text above the quote.
 */
export const createDraftReply = async (
  fetcher: Fetch,
  accessToken: string,
  messageId: string,
  html: string,
  sharedMailbox?: string | null
) => {
  const base = mailboxPath(sharedMailbox);
  const draft = await json<{
    body?: { content?: string; contentType?: string };
    id: string;
    webLink?: string;
  }>(
    await graph(
      fetcher,
      accessToken,
      `${base}/messages/${encodeURIComponent(messageId)}/createReply`,
      { method: "POST" }
    )
  );
  const quoted = draft.body?.content ?? "";
  const below =
    draft.body?.contentType?.toLowerCase() === "html"
      ? quoted
      : `<pre>${escapeHtml(quoted)}</pre>`;
  const updated = await graph(
    fetcher,
    accessToken,
    `${base}/messages/${encodeURIComponent(draft.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        body: { contentType: "html", content: `${html}${below}` },
      }),
    }
  );
  await json(updated);
  return { id: draft.id, webLink: draft.webLink ?? null };
};

// ---- Change notifications ----

export interface OutlookSubscription {
  /** AES-GCM sealed (see crypto.ts): proves a notification is from Graph. */
  clientState: string;
  expiresAt: string;
  id: string;
}

/** Subscriptions belong to the signed-in mailbox only (a Graph rule). */
export const SUBSCRIPTION_RESOURCE = "/me/mailFolders('inbox')/messages";

export const subscriptionExpiry = (now = Date.now()) =>
  new Date(now + SUBSCRIPTION_MINUTES * 60_000).toISOString();

export type SubscriptionAction = "create" | "keep" | "remove" | "renew";

/**
 * What to do with the notification subscription on a check. Delegated access
 * can't subscribe to a shared mailbox, so those rely on the hourly check.
 */
export const subscriptionAction = (
  current: Pick<OutlookSubscription, "expiresAt"> | null | undefined,
  options: { canNotify: boolean; sharedMailbox?: string | null },
  now = Date.now()
): SubscriptionAction => {
  if (!options.canNotify || options.sharedMailbox) {
    return current ? "remove" : "keep";
  }
  if (!current) {
    return "create";
  }
  const left = Date.parse(current.expiresAt) - now;
  if (!(left > 0)) {
    // Expired subscriptions are gone at Microsoft's end: make a new one.
    return "create";
  }
  return left < RENEW_WITHIN_MS ? "renew" : "keep";
};

/** A new subscription; Graph checks the notification URL before answering. */
export const createSubscription = async (
  fetcher: Fetch,
  accessToken: string,
  notificationUrl: string,
  clientState: string,
  now = Date.now()
) => {
  const created = await json<{ expirationDateTime: string; id: string }>(
    await graph(fetcher, accessToken, "/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        changeType: "created",
        notificationUrl,
        resource: SUBSCRIPTION_RESOURCE,
        expirationDateTime: subscriptionExpiry(now),
        clientState,
      }),
    })
  );
  return { id: created.id, expiresAt: created.expirationDateTime };
};

/** A later expiry for a subscription, or null when it no longer exists. */
export const renewSubscription = async (
  fetcher: Fetch,
  accessToken: string,
  id: string,
  now = Date.now()
) => {
  const response = await graph(
    fetcher,
    accessToken,
    `/subscriptions/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ expirationDateTime: subscriptionExpiry(now) }),
    }
  );
  if (response.status === 404) {
    return null;
  }
  return (await json<{ expirationDateTime: string }>(response))
    .expirationDateTime;
};

export const deleteSubscription = async (
  fetcher: Fetch,
  accessToken: string,
  id: string
) => {
  const response = await graph(
    fetcher,
    accessToken,
    `/subscriptions/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
  // Already gone is as good as deleted.
  if (!(response.ok || response.status === 404)) {
    throw new Error(`Microsoft Graph returned an error (${response.status}).`);
  }
};

/** Constant-time comparison of a notification's clientState with ours. */
export const sameSecret = (expected: string, given: unknown) => {
  if (typeof given !== "string") {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};

interface Notification {
  clientState?: unknown;
  subscriptionId?: unknown;
}

/**
 * Graph's POST to the notification URL. On creating a subscription it sends
 * `?validationToken=…`, which must come straight back as plain text within 10
 * seconds; after that, notifications must be acknowledged within 3 seconds,
 * so the check itself runs after the response (`schedule`).
 */
export const handleNotification = async (
  request: Request,
  deps: {
    /** The org and plain clientState for a subscription id, if it's ours. */
    lookup: (
      subscriptionId: string
    ) => Promise<{ clientState: string; orgId: string } | null>;
    schedule: (orgIds: string[]) => void;
  }
) => {
  const token = new URL(request.url).searchParams.get("validationToken");
  if (token !== null) {
    return new Response(token, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  let body: { value?: Notification[] };
  try {
    body = (await request.json()) as { value?: Notification[] };
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const orgIds = new Set<string>();
  for (const n of Array.isArray(body.value) ? body.value : []) {
    if (typeof n.subscriptionId !== "string") {
      continue;
    }
    const target = await deps.lookup(n.subscriptionId);
    // A wrong clientState isn't from Graph: ignore it.
    if (target && sameSecret(target.clientState, n.clientState)) {
      orgIds.add(target.orgId);
    }
  }
  if (orgIds.size) {
    deps.schedule([...orgIds]);
  }
  return new Response(null, { status: 202 });
};
