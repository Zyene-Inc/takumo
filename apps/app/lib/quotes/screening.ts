import "server-only";

import { database, forOrg } from "@repo/database";
import {
  allowedSenders,
  knownSenderRules,
  readRules,
} from "../connectors/rfq-rules";
import { domainOf, emailAddress } from "../inbound/verify";
import type { RfqText } from "./read";
import {
  chooseLane,
  freeCheck,
  recognise,
  type Screening,
  senderRule,
} from "./screen";
import { triageEmail } from "./triage";

// Runs the screening (lib/quotes/screen.ts) for one email Takumo read from a
// connected mailbox, with the shop's customers and learned senders.

/** Earlier RFQ senders that turned out to be customers. */
const EARLIER_SENDERS = 500;

/** What the screening needs to know about the mailbox it came from. */
export interface MailboxContext {
  /** The mailbox's own address, so colleagues forwarding RFQs are known. */
  account: string | null;
  /** The connection's settings (its RFQ rules list trusted senders). */
  settings: unknown;
}

/** Rfq.extracted.screen: why the RFQ is in its lane, for the inbox. */
export interface ScreenNote {
  lane: Screening["lane"];
  reason: string;
  summary: string | null;
}

export const screenNoteOf = (extracted: unknown): ScreenNote | null => {
  const screen =
    extracted && typeof extracted === "object"
      ? (extracted as { screen?: unknown }).screen
      : null;
  return screen && typeof screen === "object" && "lane" in screen
    ? (screen as ScreenNote)
    : null;
};

const listed = (rules: string[], from: string | null) => {
  const rule = senderRule(from);
  const address = emailAddress(from);
  return rules.some((r) => {
    const entry = r.trim().toLowerCase();
    return entry === rule || entry === address;
  });
};

/** Which lane an email from a mailbox goes in (never throws). */
export const screenMailboxRfq = async (
  orgId: string,
  text: RfqText,
  mailbox: MailboxContext
): Promise<Screening> => {
  const db = forOrg(database, orgId);
  const [settings, customers, earlier] = await Promise.all([
    db.shopSettings.findFirst({
      select: { knownSenders: true, blockedSenders: true },
    }),
    db.customer.findMany({
      where: {
        OR: [{ emails: { isEmpty: false } }, { domains: { isEmpty: false } }],
      },
      select: { id: true, emails: true, domains: true },
    }),
    db.rfq.findMany({
      where: { customerId: { not: null }, sender: { not: null } },
      orderBy: { receivedAt: "desc" },
      take: EARLIER_SENDERS,
      select: { sender: true },
    }),
  ]);
  const blocked = listed(settings?.blockedSenders ?? [], text.sender);
  const freeProblem = freeCheck({
    channel: text.source,
    from: text.sender,
    headers: new Map(Object.entries(text.headers ?? {})),
    subject: text.subject,
  });
  const account = emailAddress(mailbox.account);
  const who = recognise(text.sender, {
    customers,
    senders: [
      ...(settings?.knownSenders ?? []),
      ...(allowedSenders(readRules(mailbox.settings), []) ?? []),
      ...knownSenderRules(earlier.map((r) => r.sender)),
    ],
    shopDomain: account ? domainOf(account) : null,
  });
  // The paid check only for mail that got past the free ones.
  const triage =
    blocked || freeProblem
      ? null
      : await triageEmail(orgId, {
          from: text.sender,
          subject: text.subject,
          body: text.body,
        });
  return chooseLane({
    blocked,
    freeProblem,
    known: who.known,
    customerId: who.customerId,
    triage,
  });
};

/** Remember a sender as known (Quote it) or blocked (Block). */
export const learnSender = async (
  orgId: string,
  from: string | null,
  list: "knownSenders" | "blockedSenders"
) => {
  const rule = senderRule(from);
  if (!rule) {
    return;
  }
  const db = forOrg(database, orgId);
  const current = await db.shopSettings.findFirst({
    select: { knownSenders: true, blockedSenders: true },
  });
  const other = list === "knownSenders" ? "blockedSenders" : "knownSenders";
  const next = [...new Set([...(current?.[list] ?? []), rule])];
  const rest = (current?.[other] ?? []).filter((r) => r !== rule);
  await database.shopSettings.upsert({
    where: { orgId },
    create: { orgId, [list]: next, [other]: rest },
    update: { [list]: next, [other]: rest },
  });
};

/** Filtered mail is kept this long, in case the filter was wrong. */
export const FILTERED_KEEP_DAYS = 30;

/** Delete filtered mail older than FILTERED_KEEP_DAYS (all shops). */
export const removeOldFiltered = async (now = Date.now()) => {
  const { count } = await database.rfq.deleteMany({
    where: {
      status: "filtered",
      receivedAt: { lt: new Date(now - FILTERED_KEEP_DAYS * 86_400_000) },
    },
  });
  return count;
};
