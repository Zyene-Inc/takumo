// Gmail as the RFQ inbox. OAuth and HTTP live in gmail-auth, reading mail in
// gmail-messages, and reply drafts in gmail-draft.

export {
  authorizeUrl,
  canDraft,
  DEFAULT_RFQ_QUERY,
  exchangeCode,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_SCOPE,
  GmailAuthError,
  mailbox,
  refreshTokens,
  revokeToken,
  searchFor,
} from "./gmail-auth";
export {
  createDraft,
  createDraftReply,
  deleteDraft,
  draftMessage,
  newMessageMime,
  replyMime,
  sentInThread,
} from "./gmail-draft";
export {
  listMessages,
  previewMessages,
  rawMessage,
  rawMessageAndThread,
} from "./gmail-messages";
