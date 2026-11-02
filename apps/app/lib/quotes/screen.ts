// Which mailbox emails are worth Takumo's full work (reading, drawings,
// pricing, a draft reply). Free checks first, then who sent it, then a cheap
// "is this an RFQ?" check (lib/quotes/triage.ts). Pure, so every rule is
// tested. Only mail Takumo read on its own goes through here: an RFQ a person
// uploaded, pasted, dictated or forwarded was already judged by that person.

import { SHARED_DOMAINS } from "@repo/ingest";
import { domainOf, emailAddress, senderAllowed } from "../inbound/verify";
import type { RfqSource } from "./types";

/** new_sender: looks like an RFQ from someone Takumo doesn't know yet. */
/** po: a customer's purchase order, read into Incoming POs (lib/orders). */
export type Lane = "full" | "new_sender" | "filtered" | "po";

export interface Screening {
  /** Customer the sender belongs to, when matched. */
  customerId: string | null;
  lane: Lane;
  /** Why, in plain words, for the inbox. */
  reason: string;
  /** One line on what the email asks for (from the cheap check). */
  summary: string | null;
}

const AUTO_SUBJECT =
  /^(automatic reply|auto(-|\s)?reply|out of (the )?office|undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail|read:|accepted:|declined:|tentative:)/i;
const ROBOT_SENDER =
  /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|newsletter|marketing|news)([+.-].*)?@/i;
const BULK_PRECEDENCE = /^(bulk|junk|list)$/i;
const DMARC_FAIL = /\bdmarc=fail\b/i;
const SPF_FAIL = /\bspf=(fail|softfail)\b/i;
const DKIM_PASS = /\bdkim=pass\b/i;

/** Headers the free checks look at, lower-cased names. */
export type MailHeaders = ReadonlyMap<string, string>;

/**
 * Free checks, no AI: mail that is clearly not a customer asking for a price.
 * A portal's notification is exempt from the robot-sender and mailing-list
 * checks: portals send RFQs from no-reply addresses on purpose.
 */
export const freeCheck = (input: {
  channel: RfqSource;
  from: string | null;
  headers: MailHeaders;
  subject: string | null;
}): string | null => {
  const h = input.headers;
  const auth = h.get("authentication-results") ?? "";
  if (DMARC_FAIL.test(auth)) {
    return "It failed the sender checks (DMARC): it may not be from who it says.";
  }
  if (SPF_FAIL.test(auth) && !DKIM_PASS.test(auth)) {
    return "It failed the sender checks (SPF, no DKIM signature).";
  }
  if (AUTO_SUBJECT.test((input.subject ?? "").trim())) {
    return "An automatic reply or delivery notice.";
  }
  const auto = (h.get("auto-submitted") ?? "no").toLowerCase();
  if (auto !== "no" || h.has("x-autoreply") || h.has("x-autorespond")) {
    return "An automatic message.";
  }
  if (input.channel === "portal") {
    return null;
  }
  if (BULK_PRECEDENCE.test(h.get("precedence") ?? "")) {
    return "Bulk mail (a mailing list or newsletter).";
  }
  if (h.has("list-unsubscribe") || h.has("list-id")) {
    return "A newsletter or mailing list (it has an unsubscribe link).";
  }
  const address = emailAddress(input.from);
  if (address && ROBOT_SENDER.test(address)) {
    return "Sent by an automatic address, not a person.";
  }
  return null;
};

/** A learned rule for this sender: the address, or @domain for a company. */
export const senderRule = (from: string | null) => {
  const address = emailAddress(from);
  const domain = address ? domainOf(address) : null;
  if (!(address && domain)) {
    return null;
  }
  return SHARED_DOMAINS.has(domain) ? address : `@${domain}`;
};

export interface KnownCustomer {
  domains: string[];
  emails: string[];
  id: string;
}

/**
 * Who the sender is to the shop: one of its customers (by contact address,
 * or company domain unless it's shared mail), someone it works with, or a
 * stranger.
 */
export const recognise = (
  from: string | null,
  known: {
    customers: KnownCustomer[];
    /** Learned senders, the connection's sender rules, earlier RFQ senders. */
    senders: string[];
    /** The mailbox's own domain: colleagues forwarding RFQs. */
    shopDomain: string | null;
  }
): { customerId: string | null; known: boolean } => {
  const address = emailAddress(from);
  if (!address) {
    return { customerId: null, known: false };
  }
  const domain = domainOf(address);
  const shared = domain ? SHARED_DOMAINS.has(domain) : true;
  const byAddress = known.customers.find((c) => c.emails.includes(address));
  const byDomain = shared
    ? undefined
    : known.customers.find((c) => domain && c.domains.includes(domain));
  const customer = byAddress ?? byDomain;
  if (customer) {
    return { customerId: customer.id, known: true };
  }
  const colleague =
    !shared && domain !== null && domain === known.shopDomain?.toLowerCase();
  return {
    customerId: null,
    known: colleague || senderAllowed(address, known.senders),
  };
};

export type TriageKind = "rfq" | "po" | "other";

export interface Triage {
  /** high | medium | low */
  confidence: string;
  isRfq: boolean;
  /** What the email is; isRfq is kind === "rfq". Missing: rfq or other. */
  kind?: TriageKind;
  summary: string;
}

/** Where the email goes, from the checks above and the cheap RFQ check. */
export const chooseLane = (input: {
  blocked: boolean;
  customerId: string | null;
  freeProblem: string | null;
  known: boolean;
  /** null: the cheap check didn't run (daily limit, error). */
  triage: Triage | null;
}): Screening => {
  const base = {
    customerId: input.customerId,
    summary: input.triage?.summary ?? null,
  };
  if (input.blocked) {
    return { ...base, lane: "filtered", reason: "You blocked this sender." };
  }
  if (input.freeProblem) {
    return { ...base, lane: "filtered", reason: input.freeProblem };
  }
  const t = input.triage;
  // A purchase order: a customer's goes to Incoming POs; a stranger's isn't
  // worth reading.
  if (t?.kind === "po" && t.confidence !== "low") {
    return input.known
      ? {
          ...base,
          lane: "po",
          reason: "A purchase order from one of your customers.",
        }
      : {
          ...base,
          lane: "filtered",
          reason:
            "Looks like a purchase order from someone Takumo doesn't know.",
        };
  }
  // Not an RFQ, said with some confidence: even a customer's invoice or
  // shipping question doesn't need a quote.
  if (t && !t.isRfq && t.confidence !== "low") {
    return {
      ...base,
      lane: "filtered",
      reason: `Doesn't look like a request for quote: ${t.summary}`,
    };
  }
  if (input.known) {
    return {
      ...base,
      lane: "full",
      reason: input.customerId
        ? "From one of your customers."
        : "From someone you work with.",
    };
  }
  return {
    ...base,
    lane: "new_sender",
    reason: t
      ? "Looks like an RFQ from someone new. Quote it to let Takumo do the rest."
      : "From someone new, not checked yet. Quote it to let Takumo do the rest.",
  };
};

/** The headers of an .eml, for the free checks (lower-cased names). */
export const SCREEN_HEADERS = [
  "authentication-results",
  "auto-submitted",
  "x-autoreply",
  "x-autorespond",
  "precedence",
  "list-unsubscribe",
  "list-id",
] as const;
