// Writing, reading and removing the draft in Gmail or Outlook.

import "server-only";
import {
  canDraft,
  createDraft as gmailCreateDraft,
  deleteDraft as gmailDeleteDraft,
  draftMessage as gmailDraftMessage,
  createDraftReply as gmailDraftReply,
  rawMessageAndThread,
} from "../connectors/gmail";
import {
  createDraft as outlookCreateDraft,
  deleteMessage as outlookDelete,
  draftBody as outlookDraftBody,
  createDraftReply as outlookDraftReply,
} from "../connectors/outlook";
import { emailAddress } from "../inbound/verify";
import { htmlToText, parseEmail } from "./email";
import { replyHeaders, type Target } from "./mailbox-target";

export interface Written {
  draftId: string;
  messageId: string | null;
  threadId: string | null;
}

/**
 * A Gmail draft in the RFQ's thread, or null when the thread can't take one
 * (no Message-ID, no address): then it's a new message.
 */
export const gmailInThread = async (
  target: Target,
  html: string,
  pdf: { bytes: Uint8Array; mediaType: string; name: string }
): Promise<Written | null> => {
  if (!(target.inThread && target.threadId)) {
    return null;
  }
  const token = target.connection.token;
  const { bytes } = await rawMessageAndThread(fetch, token, target.inThread);
  const headers = replyHeaders(bytes);
  const original = parseEmail(new TextDecoder().decode(bytes));
  const to =
    (target.redirect ? target.to : null) ??
    emailAddress(headers.replyTo) ??
    emailAddress(headers.from) ??
    target.to;
  if (!(headers.messageId && to)) {
    return null;
  }
  const draft = await gmailDraftReply(
    fetch,
    token,
    {
      threadId: target.threadId,
      messageId: headers.messageId,
      references: headers.references,
      // Gmail only keeps a draft in the thread when its subject matches the
      // thread's, so an updated draft keeps the same subject.
      subject: original.subject ?? "",
      to,
    },
    html,
    pdf
  );
  return {
    draftId: draft.id,
    messageId: draft.messageId,
    threadId: draft.threadId,
  };
};

/** Put a new draft in the mailbox. */
export const createInMailbox = async (
  target: Target,
  content: { html: string; subject: string },
  pdf: { bytes: Uint8Array; mediaType: string; name: string },
  subjectSuffix: string,
  originalSubject: string | null
): Promise<Written> => {
  const token = target.connection.token;
  if (target.provider === "gmail") {
    if (!canDraft(target.connection.connection.scope)) {
      throw new Error(
        "Reconnect Gmail under Settings → Integrations and allow drafts, so Takumo can put the reply in your mailbox."
      );
    }
    const inThread = await gmailInThread(target, content.html, pdf);
    if (inThread) {
      return inThread;
    }
    if (!target.to) {
      throw new Error("There's no address to send the quote to.");
    }
    const draft = await gmailCreateDraft(
      fetch,
      token,
      { to: target.to, subject: `${content.subject}${subjectSuffix}` },
      content.html,
      pdf
    );
    return {
      draftId: draft.id,
      messageId: draft.messageId,
      threadId: draft.threadId,
    };
  }
  if (target.inThread) {
    const draft = await outlookDraftReply(
      fetch,
      token,
      target.inThread,
      content.html,
      target.sharedMailbox,
      {
        attachment: pdf,
        ...(target.redirect && target.to ? { to: target.to } : {}),
        ...(subjectSuffix
          ? { subject: `RE: ${originalSubject ?? ""}${subjectSuffix}` }
          : {}),
      }
    );
    return {
      draftId: draft.id,
      messageId: null,
      threadId: draft.conversationId ?? target.threadId,
    };
  }
  if (!target.to) {
    throw new Error("There's no address to send the quote to.");
  }
  const draft = await outlookCreateDraft(
    fetch,
    token,
    { to: target.to, subject: `${content.subject}${subjectSuffix}` },
    content.html,
    target.sharedMailbox,
    pdf
  );
  return {
    draftId: draft.id,
    messageId: null,
    threadId: draft.conversationId,
  };
};

/** The draft's current text in the mailbox, or null when it's gone or sent. */
export const mailboxText = async (target: Target, draftId: string) => {
  const token = target.connection.token;
  if (target.provider === "gmail") {
    const raw = await gmailDraftMessage(fetch, token, draftId);
    return raw ? parseEmail(new TextDecoder().decode(raw)).body : null;
  }
  const html = await outlookDraftBody(
    fetch,
    token,
    draftId,
    target.sharedMailbox
  );
  return html === null ? null : htmlToText(html);
};

export const removeDraft = (target: Target, draftId: string) =>
  target.provider === "gmail"
    ? gmailDeleteDraft(fetch, target.connection.token, draftId)
    : outlookDelete(
        fetch,
        target.connection.token,
        draftId,
        target.sharedMailbox
      );
