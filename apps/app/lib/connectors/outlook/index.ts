// Outlook (Microsoft 365) as the RFQ inbox: OAuth 2.0 with a multi-tenant
// Entra app, new Inbox mail through Microsoft Graph delta queries, and change
// notifications so an RFQ shows up within a minute or two instead of at the
// next hourly check. Each RFQ is read from its MIME (.eml) like an upload.
// Mail.ReadWrite is only for leaving reply drafts later; Takumo never sends.
// HTTP calls take `fetch`, so tested without the network.

export {
  adminConsentUrl,
  authorizeUrl,
  canReadMail,
  exchangeCode,
  needsAdminConsent,
  pkceVerifier,
  refreshTokens,
} from "./auth";
export {
  addAttachment,
  createDraft,
  createDraftReply,
  deleteMessage,
  draftBody,
  INLINE_ATTACHMENT_BYTES,
  sentInConversation,
  UPLOAD_CHUNK_BYTES,
} from "./drafts";
export type { MicrosoftTokens } from "./graph";
export {
  MAX_MESSAGES,
  OUTLOOK_SCOPES,
  OutlookAuthError,
  OutlookConsentError,
  OutlookDeltaExpired,
  OutlookMailboxError,
} from "./graph";
export type { GraphMessage, MailFolder } from "./mail";
export {
  DEFAULT_FOLDER,
  firstDeltaUrl,
  listFolders,
  mailbox,
  previewMessages,
  rawMessage,
  readDelta,
  rfqMessages,
} from "./mail";
export type { OutlookSubscription } from "./subscriptions";
export {
  createSubscription,
  deleteSubscription,
  handleNotification,
  renewSubscription,
  SUBSCRIPTION_RESOURCE,
  subscriptionAction,
  subscriptionResource,
} from "./subscriptions";
