// Which emails count as RFQs, shared by Gmail and Outlook so both mailboxes
// pick out the same messages. Gmail runs it as a search; Outlook can't search
// a delta query, so the subject is checked here.

/** Subject words and phrases that mark a request for quote. */
export const RFQ_SUBJECT_TERMS = [
  "rfq",
  "request for quote",
  "request for quotation",
  "quote request",
  "please quote",
] as const;

const escapeRegExp = (term: string) =>
  term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whole words only, like Gmail's subject search: "RFQ-2211" counts,
// "rfqs" and "request for quotes" don't.
const SUBJECT_PATTERN = new RegExp(
  `\\b(${RFQ_SUBJECT_TERMS.map((t) => escapeRegExp(t).replace(/ /g, "\\s+")).join("|")})\\b`,
  "i"
);

export const isRfqSubject = (subject: string | null | undefined) =>
  SUBJECT_PATTERN.test(subject ?? "");

/** One line of the "test with the last 20 emails" preview. */
export interface PreviewMessage {
  from: string | null;
  id: string;
  isRfq: boolean;
  receivedAt: string | null;
  subject: string | null;
}
