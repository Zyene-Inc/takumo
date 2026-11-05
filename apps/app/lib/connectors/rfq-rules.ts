// Which emails count as RFQs, shared by Gmail and Outlook so both mailboxes
// pick out the same messages. Gmail runs it as a search; Outlook can't search
// a delta query, so the subject is checked here. Each shop can add its own
// subject words and narrow it down (attachments only, known senders only),
// saved in `Connection.settings.rfqRules`. Pure, so tested without a mailbox.

import { SHARED_DOMAINS } from "@repo/ingest";
import { domainOf, emailAddress, senderAllowed } from "../inbound/verify";

/** Subject words and phrases that mark a request for quote. */
const RFQ_SUBJECT_TERMS = [
  "rfq",
  "request for quote",
  "request for quotation",
  "quote request",
  "please quote",
] as const;

/** Limits on what a shop can save, so the Gmail search stays valid. */
export const MAX_EXTRA_TERMS = 10;
const MAX_TERM_LENGTH = 40;
export const MAX_SENDERS = 50;

export interface RfqRules {
  /** More subject words or phrases, on top of Takumo's. */
  extraTerms: string[];
  /** Only mail from senders on earlier RFQs that were linked to a customer. */
  knownCustomersOnly: boolean;
  /** Only mail with an attachment (most RFQs carry a drawing or PDF). */
  requireAttachments: boolean;
  /** Only mail from these addresses or @domains (empty: anyone). */
  senders: string[];
}

export const DEFAULT_RULES: RfqRules = {
  extraTerms: [],
  knownCustomersOnly: false,
  requireAttachments: false,
  senders: [],
};

const TERM_CHARS = /[^\p{L}\p{N} &/#.-]/gu;
const SPACE_RUNS = /\s+/g;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const A_SPACE = / /g;

/** A subject word as saved: lower case, single spaces, no search syntax. */
export const cleanTerm = (term: string) =>
  term
    .toLowerCase()
    .replace(TERM_CHARS, " ")
    .replace(SPACE_RUNS, " ")
    .trim()
    .slice(0, MAX_TERM_LENGTH);

const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

/** The rules saved on a connection, with anything odd dropped. */
export const readRules = (settings: unknown): RfqRules => {
  const raw =
    settings && typeof settings === "object"
      ? (settings as { rfqRules?: unknown }).rfqRules
      : null;
  if (!raw || typeof raw !== "object") {
    return DEFAULT_RULES;
  }
  const r = raw as Record<string, unknown>;
  return {
    extraTerms: unique(strings(r.extraTerms).map(cleanTerm)).slice(
      0,
      MAX_EXTRA_TERMS
    ),
    knownCustomersOnly: r.knownCustomersOnly === true,
    requireAttachments: r.requireAttachments === true,
    senders: unique(
      strings(r.senders).map((s) => s.trim().toLowerCase())
    ).slice(0, MAX_SENDERS),
  };
};

const escapeRegExp = (term: string) => term.replace(REGEX_SPECIAL, "\\$&");

// Whole words only, like Gmail's subject search: "RFQ-2211" counts,
// "rfqs" and "request for quotes" don't.
const subjectPattern = (terms: readonly string[]) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}_])(${terms.map((t) => escapeRegExp(t).replace(A_SPACE, "\\s+")).join("|")})(?![\\p{L}\\p{N}_])`,
    "iu"
  );

const DEFAULT_PATTERN = subjectPattern(RFQ_SUBJECT_TERMS);

export const isRfqSubject = (
  subject: string | null | undefined,
  extraTerms: readonly string[] = []
) => {
  const pattern = extraTerms.length
    ? subjectPattern([...RFQ_SUBJECT_TERMS, ...extraTerms])
    : DEFAULT_PATTERN;
  return pattern.test(subject ?? "");
};

const gmailTerm = (t: string) => (t.includes(" ") ? `"${t}"` : t);

/** Takumo's Gmail search for RFQs, with the shop's extra subject words. */
export const gmailSubjectQuery = (extraTerms: readonly string[] = []) =>
  `subject:(${[...RFQ_SUBJECT_TERMS, ...extraTerms].map(gmailTerm).join(" OR ")}) -in:sent -in:chats`;

/** The Gmail search: the shop's own, or Takumo's, narrowed by the rules. */
export const gmailQuery = (
  custom: string | null | undefined,
  rules: RfqRules
) => {
  const own = custom?.trim();
  // A saved copy of Takumo's own search still takes the extra words.
  const base =
    own && own !== gmailSubjectQuery()
      ? own
      : gmailSubjectQuery(rules.extraTerms);
  return `${base.slice(0, 500)}${rules.requireAttachments ? " has:attachment" : ""}`;
};

/**
 * Sender rules from the "From" of earlier RFQs that were linked to a
 * customer: the whole company domain, or the address for shared domains.
 */
export const knownSenderRules = (senders: (string | null)[]) =>
  unique(
    senders.map((s) => {
      const address = emailAddress(s);
      const domain = address ? domainOf(address) : null;
      if (!(address && domain)) {
        return "";
      }
      return SHARED_DOMAINS.has(domain) ? address : `@${domain}`;
    })
  );

/** Who may send RFQs under these rules, or null when anyone may. */
export const allowedSenders = (rules: RfqRules, known: string[]) =>
  rules.senders.length || rules.knownCustomersOnly
    ? [...rules.senders, ...(rules.knownCustomersOnly ? known : [])]
    : null;

/** Whether a sender gets through the rules' sender filter. */
export const senderPasses = (from: string | null, allowed: string[] | null) =>
  allowed === null || senderAllowed(from, allowed);

/** One line of the "test with the last 20 emails" preview. */
export interface PreviewMessage {
  from: string | null;
  id: string;
  isRfq: boolean;
  receivedAt: string | null;
  subject: string | null;
}
