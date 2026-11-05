// Gmail as the RFQ inbox: OAuth 2.0, and new messages that look like requests
// for quote. Each becomes an RFQ, read the same way as an uploaded .eml
// (attachments included). Compose permission lets Takumo leave a reply draft
// in the RFQ's thread; it never sends. HTTP calls take `fetch`, so tested
// without the network.

import {
  gmailSubjectQuery,
  type PreviewMessage,
  senderPasses,
} from "./rfq-rules";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
/** Create drafts (never send): for reply drafts in the RFQ's thread. */
export const GMAIL_COMPOSE_SCOPE =
  "https://www.googleapis.com/auth/gmail.compose";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** What counts as an RFQ unless the shop sets its own Gmail search. */
export const DEFAULT_RFQ_QUERY = gmailSubjectQuery();
/** Messages read per check (the rest wait for the next one). */
const MAX_MESSAGES = 20;

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

interface GoogleTokens {
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

/** The message as an .eml file (RFC 822 bytes), and its Gmail thread. */
export const rawMessageAndThread = async (
  fetcher: Fetch,
  accessToken: string,
  id: string
) => {
  const { raw, threadId } = await get<{ raw: string; threadId?: string }>(
    fetcher,
    accessToken,
    `/messages/${encodeURIComponent(id)}?format=raw`
  );
  return {
    bytes: new Uint8Array(Buffer.from(raw, "base64url")),
    threadId: threadId ?? null,
  };
};

/** The message as an .eml file (RFC 822 bytes). */
export const rawMessage = async (
  fetcher: Fetch,
  accessToken: string,
  id: string
) => (await rawMessageAndThread(fetcher, accessToken, id)).bytes;

interface GmailHeaders {
  payload?: { headers?: { name: string; value: string }[] };
}

const header = (message: GmailHeaders, name: string) =>
  message.payload?.headers?.find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  )?.value ?? null;

/**
 * The last 20 emails in the mailbox, each marked whether the shop's RFQ
 * search and sender rules pick it up. Reads headers only; nothing is imported.
 */
export const previewMessages = async (
  fetcher: Fetch,
  accessToken: string,
  query: string | null | undefined,
  /** The rules' sender filter (null: anyone). */
  allowed: string[] | null = null
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
      const from = header(message, "From");
      return {
        id,
        subject: header(message, "Subject"),
        from,
        receivedAt:
          received && !Number.isNaN(received.getTime())
            ? received.toISOString()
            : null,
        isRfq: rfqs.has(id) && senderPasses(from, allowed),
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

interface GmailReplyTo {
  /** The RFQ message's Message-ID header, e.g. "<abc@mail.example.com>". */
  messageId: string;
  /** Its References header, if any, so the whole chain stays linked. */
  references?: string | null;
  subject: string | null;
  threadId: string;
  to: string;
}

/** A file attached to a draft (the quote PDF). */
interface MimeAttachment {
  bytes: Uint8Array;
  mediaType: string;
  name: string;
}

const base64Lines = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64").replace(BASE64_LINE, "$&\r\n");

const SAFE_FILE_NAME = /["\\\r\n]/g;

/** Headers, then an HTML body and (optionally) one attachment. */
const mime = (
  headers: string[],
  html: string,
  attachment: MimeAttachment | null | undefined,
  boundary: string
) => {
  const htmlPart = [
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(html, "utf8")),
  ];
  if (!attachment) {
    return [...headers, "MIME-Version: 1.0", ...htmlPart].join("\r\n");
  }
  const name = attachment.name.replace(SAFE_FILE_NAME, "");
  return [
    ...headers,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...htmlPart,
    `--${boundary}`,
    `Content-Type: ${attachment.mediaType}; name="${name}"`,
    `Content-Disposition: attachment; filename="${name}"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(attachment.bytes),
    `--${boundary}--`,
    "",
  ].join("\r\n");
};

const newBoundary = () =>
  `takumo-${Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex")}`;

/** The reply as an RFC 822 message, threaded under the RFQ. */
export const replyMime = (
  reply: GmailReplyTo,
  html: string,
  attachment?: MimeAttachment | null,
  boundary = newBoundary()
) => {
  const subject = oneLine(reply.subject ?? "");
  const references = [reply.references, reply.messageId]
    .filter(Boolean)
    .map((r) => oneLine(r as string))
    .join(" ");
  return mime(
    [
      `To: ${oneLine(reply.to)}`,
      // Gmail threads a draft only when the subject matches the thread's.
      `Subject: ${encodeHeader(REPLY_PREFIX.test(subject) ? subject : `Re: ${subject}`)}`,
      `In-Reply-To: ${oneLine(reply.messageId)}`,
      `References: ${references}`,
    ],
    html,
    attachment,
    boundary
  );
};

/** A new message (an RFQ that didn't come by email), not in any thread. */
export const newMessageMime = (
  message: { subject: string; to: string },
  html: string,
  attachment?: MimeAttachment | null,
  boundary = newBoundary()
) =>
  mime(
    [
      `To: ${oneLine(message.to)}`,
      `Subject: ${encodeHeader(oneLine(message.subject))}`,
    ],
    html,
    attachment,
    boundary
  );

/**
 * A reply draft in the RFQ's thread (users.drafts.create), for the estimator
 * to review and send from Gmail. Needs the compose permission.
 */
export const createDraftReply = async (
  fetcher: Fetch,
  accessToken: string,
  reply: GmailReplyTo,
  html: string,
  attachment?: MimeAttachment | null
) => {
  const draft = await get<{
    id: string;
    message?: { id: string; threadId?: string };
  }>(fetcher, accessToken, "/drafts", {
    method: "POST",
    body: JSON.stringify({
      message: {
        threadId: reply.threadId,
        raw: Buffer.from(replyMime(reply, html, attachment), "utf8").toString(
          "base64url"
        ),
      },
    }),
  });
  return {
    id: draft.id,
    messageId: draft.message?.id ?? null,
    threadId: draft.message?.threadId ?? reply.threadId,
  };
};

/** A draft of a new message (no thread), e.g. a quote for a phoned-in RFQ. */
export const createDraft = async (
  fetcher: Fetch,
  accessToken: string,
  message: { subject: string; to: string },
  html: string,
  attachment?: MimeAttachment | null
) => {
  const draft = await get<{
    id: string;
    message?: { id: string; threadId?: string };
  }>(fetcher, accessToken, "/drafts", {
    method: "POST",
    body: JSON.stringify({
      message: {
        raw: Buffer.from(
          newMessageMime(message, html, attachment),
          "utf8"
        ).toString("base64url"),
      },
    }),
  });
  return {
    id: draft.id,
    messageId: draft.message?.id ?? null,
    threadId: draft.message?.threadId ?? null,
  };
};

/** A draft's message as .eml bytes, or null when it's gone (sent or deleted). */
export const draftMessage = async (
  fetcher: Fetch,
  accessToken: string,
  draftId: string
) => {
  const response = await fetcher(
    `${GMAIL_API}/drafts/${encodeURIComponent(draftId)}?format=raw`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (response.status === 404) {
    return null;
  }
  if (response.status === 401) {
    throw new GmailAuthError("Gmail access expired. Reconnect it.");
  }
  if (!response.ok) {
    throw new Error(`Gmail returned an error (${response.status}).`);
  }
  const draft = (await response.json()) as { message?: { raw?: string } };
  return draft.message?.raw
    ? new Uint8Array(Buffer.from(draft.message.raw, "base64url"))
    : null;
};

/** Remove a draft Takumo made (to replace it); gone already is fine. */
export const deleteDraft = async (
  fetcher: Fetch,
  accessToken: string,
  draftId: string
) => {
  const response = await fetcher(
    `${GMAIL_API}/drafts/${encodeURIComponent(draftId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (response.status === 401) {
    throw new GmailAuthError("Gmail access expired. Reconnect it.");
  }
  if (!(response.ok || response.status === 404)) {
    throw new Error(`Gmail returned an error (${response.status}).`);
  }
};

/**
 * The first message sent from the mailbox in a thread after a time (the
 * estimator's reply to the RFQ), or null.
 */
export const sentInThread = async (
  fetcher: Fetch,
  accessToken: string,
  threadId: string,
  after: Date
) => {
  const response = await fetcher(
    `${GMAIL_API}/threads/${encodeURIComponent(threadId)}?format=minimal`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (response.status === 404) {
    return [];
  }
  if (response.status === 401) {
    throw new GmailAuthError("Gmail access expired. Reconnect it.");
  }
  if (!response.ok) {
    throw new Error(`Gmail returned an error (${response.status}).`);
  }
  const thread = (await response.json()) as {
    messages?: { id: string; internalDate?: string; labelIds?: string[] }[];
  };
  // Every message sent after the draft, oldest first: the first one may be
  // a "got it, quote to follow" and not the quote.
  return (thread.messages ?? [])
    .filter(
      (m) =>
        m.labelIds?.includes("SENT") &&
        !m.labelIds.includes("DRAFT") &&
        Number(m.internalDate ?? 0) > after.getTime()
    )
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate))
    .map((m) => ({ id: m.id, at: new Date(Number(m.internalDate)) }));
};
