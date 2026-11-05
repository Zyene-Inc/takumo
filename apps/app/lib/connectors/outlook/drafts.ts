// Draft replies in the customer's thread, with attachments.

import { type Fetch, graph, json, mailboxPath } from "./graph";

export const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c
  );

/** A file attached to a draft (the quote PDF). */
export interface DraftAttachment {
  bytes: Uint8Array;
  mediaType: string;
  name: string;
}

/** Graph takes attachments up to this size inline; larger ones in pieces. */
export const INLINE_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/** Upload pieces: a multiple of 320 KiB, as Graph asks. */
export const UPLOAD_CHUNK_BYTES = 10 * 320 * 1024;

/** Attach a file to a draft: inline when small, an upload session if not. */
export const addAttachment = async (
  fetcher: Fetch,
  accessToken: string,
  messageId: string,
  file: DraftAttachment,
  sharedMailbox?: string | null
) => {
  const base = `${mailboxPath(sharedMailbox)}/messages/${encodeURIComponent(messageId)}/attachments`;
  if (file.bytes.length < INLINE_ATTACHMENT_BYTES) {
    await json(
      await graph(fetcher, accessToken, base, {
        method: "POST",
        sharedMailbox,
        body: JSON.stringify({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: file.name,
          contentType: file.mediaType,
          contentBytes: Buffer.from(file.bytes).toString("base64"),
        }),
      })
    );
    return;
  }
  const session = await json<{ uploadUrl: string }>(
    await graph(fetcher, accessToken, `${base}/createUploadSession`, {
      method: "POST",
      sharedMailbox,
      body: JSON.stringify({
        AttachmentItem: {
          attachmentType: "file",
          name: file.name,
          size: file.bytes.length,
          contentType: file.mediaType,
        },
      }),
    })
  );
  const total = file.bytes.length;
  for (let from = 0; from < total; from += UPLOAD_CHUNK_BYTES) {
    const to = Math.min(from + UPLOAD_CHUNK_BYTES, total);
    // The upload URL carries its own authorization: no bearer token here.
    const response = await fetcher(session.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(to - from),
        "Content-Range": `bytes ${from}-${to - 1}/${total}`,
      },
      body: file.bytes.slice(from, to),
    });
    if (!response.ok) {
      throw new Error(
        `Microsoft Graph refused the attachment (${response.status}).`
      );
    }
  }
};

export interface GraphDraft {
  body?: { content?: string; contentType?: string };
  conversationId?: string;
  id: string;
  webLink?: string;
}

/**
 * A reply draft to the RFQ, left in the mailbox's Drafts for the estimator to
 * review and send: createReply (which threads it and quotes the original),
 * then our text above the quote, then the quote PDF.
 */
export const createDraftReply = async (
  fetcher: Fetch,
  accessToken: string,
  messageId: string,
  html: string,
  sharedMailbox?: string | null,
  options: {
    attachment?: DraftAttachment | null;
    subject?: string;
    /** Instead of the thread's sender (a colleague who forwarded the RFQ). */
    to?: string | null;
  } = {}
) => {
  const base = mailboxPath(sharedMailbox);
  const draft = await json<GraphDraft>(
    await graph(
      fetcher,
      accessToken,
      `${base}/messages/${encodeURIComponent(messageId)}/createReply`,
      { method: "POST", sharedMailbox }
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
      sharedMailbox,
      body: JSON.stringify({
        body: { contentType: "html", content: `${html}${below}` },
        ...(options.subject ? { subject: options.subject } : {}),
        ...(options.to
          ? { toRecipients: [{ emailAddress: { address: options.to } }] }
          : {}),
      }),
    }
  );
  await json(updated);
  if (options.attachment) {
    await addAttachment(
      fetcher,
      accessToken,
      draft.id,
      options.attachment,
      sharedMailbox
    );
  }
  return {
    id: draft.id,
    webLink: draft.webLink ?? null,
    conversationId: draft.conversationId ?? null,
  };
};

/** A draft of a new message (an RFQ that didn't come by email). */
export const createDraft = async (
  fetcher: Fetch,
  accessToken: string,
  message: { subject: string; to: string },
  html: string,
  sharedMailbox?: string | null,
  attachment?: DraftAttachment | null
) => {
  const draft = await json<GraphDraft>(
    await graph(
      fetcher,
      accessToken,
      `${mailboxPath(sharedMailbox)}/messages`,
      {
        method: "POST",
        sharedMailbox,
        body: JSON.stringify({
          subject: message.subject,
          body: { contentType: "html", content: html },
          toRecipients: [{ emailAddress: { address: message.to } }],
        }),
      }
    )
  );
  if (attachment) {
    await addAttachment(
      fetcher,
      accessToken,
      draft.id,
      attachment,
      sharedMailbox
    );
  }
  return {
    id: draft.id,
    webLink: draft.webLink ?? null,
    conversationId: draft.conversationId ?? null,
  };
};

/**
 * A draft's body as HTML, or null when it's no longer a draft (sent) or gone
 * (deleted). Immutable ids keep pointing at it when it's moved.
 */
export const draftBody = async (
  fetcher: Fetch,
  accessToken: string,
  messageId: string,
  sharedMailbox?: string | null
) => {
  const response = await graph(
    fetcher,
    accessToken,
    `${mailboxPath(sharedMailbox)}/messages/${encodeURIComponent(messageId)}?$select=body,isDraft`
  );
  if (response.status === 404) {
    return null;
  }
  const message = await json<{
    body?: { content?: string };
    isDraft?: boolean;
  }>(response);
  return message.isDraft === false ? null : (message.body?.content ?? "");
};

/** Remove a draft Takumo made (to replace it); gone already is fine. */
export const deleteMessage = async (
  fetcher: Fetch,
  accessToken: string,
  messageId: string,
  sharedMailbox?: string | null
) => {
  const response = await graph(
    fetcher,
    accessToken,
    `${mailboxPath(sharedMailbox)}/messages/${encodeURIComponent(messageId)}`,
    { method: "DELETE" }
  );
  if (!(response.ok || response.status === 404)) {
    throw new Error(`Microsoft Graph returned an error (${response.status}).`);
  }
};

/** The first message in Sent Items in a conversation after a time, or null. */
export const sentInConversation = async (
  fetcher: Fetch,
  accessToken: string,
  conversationId: string,
  after: Date,
  sharedMailbox?: string | null
) => {
  const filter = `conversationId eq '${conversationId.replaceAll("'", "''")}' and sentDateTime ge ${after.toISOString()}`;
  const params = new URLSearchParams({
    $filter: filter,
    $select: "id,sentDateTime,body,hasAttachments",
    $top: "10",
  });
  const page = await json<{
    value?: {
      body?: { content?: string };
      /** Files attached (Graph leaves inline images out of this). */
      hasAttachments?: boolean;
      id: string;
      sentDateTime?: string;
    }[];
  }>(
    await graph(
      fetcher,
      accessToken,
      `${mailboxPath(sharedMailbox)}/mailFolders('sentitems')/messages?${params}`,
      { sharedMailbox }
    )
  );
  // Every message sent after the draft, oldest first: the first one may be
  // a "got it, quote to follow" and not the quote.
  return (page.value ?? [])
    .filter(
      (m) => m.sentDateTime && Date.parse(m.sentDateTime) > after.getTime()
    )
    .sort(
      (a, b) =>
        Date.parse(a.sentDateTime ?? "") - Date.parse(b.sentDateTime ?? "")
    )
    .map((m) => ({
      id: m.id,
      at: new Date(m.sentDateTime as string),
      html: m.body?.content ?? "",
      hasAttachments: m.hasAttachments === true,
    }));
};

// ---- Change notifications ----
