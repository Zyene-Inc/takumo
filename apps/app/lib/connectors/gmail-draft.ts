import { type Fetch, GMAIL_API, GmailAuthError, get } from "./gmail-auth";

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const REPLY_PREFIX = /^re:/i;
const LINE_BREAKS = /[\r\n]+/g;
const BASE64_LINE = /.{76}/g;

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
