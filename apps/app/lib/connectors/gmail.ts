// Gmail as the RFQ inbox: OAuth 2.0, and new messages that look like requests
// for quote. Each becomes an RFQ, read the same way as an uploaded .eml
// (attachments included). Compose permission lets Takumo leave a reply draft
// in the RFQ's thread; it never sends. HTTP calls take `fetch`, so tested
// without the network.

import { type PreviewMessage, RFQ_SUBJECT_TERMS } from "./rfq-rules";

export const GOOGLE_AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
/** Create drafts (never send): for reply drafts in the RFQ's thread. */
export const GMAIL_COMPOSE_SCOPE =
  "https://www.googleapis.com/auth/gmail.compose";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** What counts as an RFQ unless the shop sets its own Gmail search. */
export const DEFAULT_RFQ_QUERY = `subject:(${RFQ_SUBJECT_TERMS.map((t) => (t.includes(" ") ? `"${t}"` : t)).join(" OR ")}) -in:sent -in:chats`;
/** Messages read per check (the rest wait for the next one). */
export const MAX_MESSAGES = 20;

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

type Fetch = typeof fetch;

export interface GoogleTokens {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export class GmailAuthError extends Error {}

const SPACES = /\s+/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const REPLY_PREFIX = /^re:/i;
const LINE_BREAKS = /[\r\n]+/g;
const BASE64_LINE = /.{76}/g;

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

const get = async <T>(
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

/** Ids of messages matching the search, newest first. */
export const listMessages = async (
  fetcher: Fetch,
  accessToken: string,
  q: string
): Promise<string[]> =>
  (
    (
      await get<{ messages?: { id: string }[] }>(
        fetcher,
        accessToken,
        `/messages?${new URLSearchParams({ q, maxResults: String(MAX_MESSAGES) })}`
      )
    ).messages ?? []
  ).map((m) => m.id);

/** The message as an .eml file (RFC 822 bytes). */
export const rawMessage = async (
  fetcher: Fetch,
  accessToken: string,
  id: string
) => {
  const { raw } = await get<{ raw: string }>(
    fetcher,
    accessToken,
    `/messages/${encodeURIComponent(id)}?format=raw`
  );
  return new Uint8Array(Buffer.from(raw, "base64url"));
};

interface GmailHeaders {
  payload?: { headers?: { name: string; value: string }[] };
}

const header = (message: GmailHeaders, name: string) =>
  message.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  )?.value ?? null;

/**
 * The last 20 emails in the mailbox, each marked whether the shop's RFQ
 * search picks it up. Reads headers only; nothing is imported.
 */
export const previewMessages = async (
  fetcher: Fetch,
  accessToken: string,
  query: string | null | undefined
): Promise<PreviewMessage[]> => {
  const [recent, matching] = await Promise.all([
    listMessages(fetcher, accessToken, "-in:sent -in:chats -in:drafts"),
    // Any of the last 20 that matches is among the 20 newest matches.
    listMessages(fetcher, accessToken, query?.trim() || DEFAULT_RFQ_QUERY),
  ]);
  const rfqs = new Set(matching);
  return Promise.all(
    recent.map(async (id) => {
      const params = new URLSearchParams({ format: "metadata" });
      for (const name of ["Subject", "From", "Date"]) {
        params.append("metadataHeaders", name);
      }
      const message = await get<GmailHeaders>(
        fetcher,
        accessToken,
        `/messages/${encodeURIComponent(id)}?${params}`
      );
      const date = header(message, "Date");
      const received = date ? new Date(date) : null;
      return {
        id,
        subject: header(message, "Subject"),
        from: header(message, "From"),
        receivedAt:
          received && !Number.isNaN(received.getTime())
            ? received.toISOString()
            : null,
        isRfq: rfqs.has(id),
      };
    })
  );
};

/** RFC 2047 for a header that isn't plain ASCII (e.g. an accented subject). */
const encodeHeader = (value: string) =>
  PRINTABLE_ASCII.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

const oneLine = (value: string) => value.replace(LINE_BREAKS, " ").trim();

export interface GmailReplyTo {
  /** The RFQ message's Message-ID header, e.g. "<abc@mail.example.com>". */
  messageId: string;
  /** Its References header, if any, so the whole chain stays linked. */
  references?: string | null;
  subject: string | null;
  threadId: string;
  to: string;
}

/** The reply as an RFC 822 message, threaded under the RFQ. */
export const replyMime = (reply: GmailReplyTo, html: string) => {
  const subject = oneLine(reply.subject ?? "");
  const references = [reply.references, reply.messageId]
    .filter(Boolean)
    .map((r) => oneLine(r as string))
    .join(" ");
  return [
    `To: ${oneLine(reply.to)}`,
    // Gmail threads a draft only when the subject matches the thread's.
    `Subject: ${encodeHeader(REPLY_PREFIX.test(subject) ? subject : `Re: ${subject}`)}`,
    `In-Reply-To: ${oneLine(reply.messageId)}`,
    `References: ${references}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html, "utf8").toString("base64").replace(BASE64_LINE, "$&\r\n"),
  ].join("\r\n");
};

/**
 * A reply draft in the RFQ's thread (users.drafts.create), for the estimator
 * to review and send from Gmail. Needs the compose permission.
 */
export const createDraftReply = async (
  fetcher: Fetch,
  accessToken: string,
  reply: GmailReplyTo,
  html: string
) => {
  const draft = await get<{ id: string; message?: { id: string } }>(
    fetcher,
    accessToken,
    "/drafts",
    {
      method: "POST",
      body: JSON.stringify({
        message: {
          threadId: reply.threadId,
          raw: Buffer.from(replyMime(reply, html), "utf8").toString(
            "base64url"
          ),
        },
      }),
    }
  );
  return { id: draft.id, messageId: draft.message?.id ?? null };
};
