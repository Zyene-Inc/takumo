// Turning mailbox messages into RFQs: sender rules, duplicates and skip reasons.

import "server-only";
import { database, forOrg } from "@repo/database";
import { track } from "../../analytics";
import { intakeRfq } from "../../quotes/intake";
import { readRfqFile } from "../../quotes/read";
import type { Lane } from "../../quotes/screen";
import { rfqLabel } from "../../quotes/types";
import {
  allowedSenders,
  knownSenderRules,
  type RfqRules,
  senderPasses,
} from "../rfq-rules";
import { fingerprint, type MailThread } from "../thread";
import {
  type ConnectionRow,
  KNOWN_SENDER_RFQS,
  type SyncResult,
} from "./connection";

/**
 * Who may send RFQs under the shop's rules (null: anyone). "Known customers"
 * are the senders of earlier RFQs that were linked to a customer.
 */
export const senderFilter = async (orgId: string, rules: RfqRules) => {
  if (!rules.knownCustomersOnly) {
    return allowedSenders(rules, []);
  }
  const earlier = await forOrg(database, orgId).rfq.findMany({
    where: { customerId: { not: null }, sender: { not: null } },
    orderBy: { receivedAt: "desc" },
    take: KNOWN_SENDER_RFQS,
    select: { sender: true },
  });
  return allowedSenders(rules, knownSenderRules(earlier.map((r) => r.sender)));
};

/**
 * The same RFQ coming round again in a reply chain: an RFQ from the same
 * conversation with the same attachments is already in Takumo. Its number,
 * or null.
 */
export const alreadyHave = async (orgId: string, mail: MailThread) => {
  if (!mail.threadId) {
    return null;
  }
  const found = await forOrg(database, orgId).rfq.findFirst({
    where: {
      AND: [
        { extracted: { path: ["mail", "threadId"], equals: mail.threadId } },
        {
          extracted: {
            path: ["mail", "attachmentsHash"],
            equals: mail.attachmentsHash,
          },
        },
      ],
    },
    select: { number: true },
  });
  return found?.number ?? null;
};

/** Messages already read into an RFQ or a customer PO (never read twice). */
export const seenMessages = async (orgId: string, ids: string[]) => {
  const db = forOrg(database, orgId);
  const [rfqs, pos] = await Promise.all([
    // Any channel: a portal or form email is still read once.
    db.rfq.findMany({
      where: { sourceId: { in: ids } },
      select: { sourceId: true },
    }),
    db.customerPo.findMany({
      where: { sourceId: { in: ids } },
      select: { sourceId: true },
    }),
  ]);
  return new Set([...rfqs, ...pos].map((r) => r.sourceId));
};

/** The sync note for a new RFQ, by where screening put it. */
export const laneNote = (
  text: { sender: string | null; subject: string | null },
  number: number,
  lane: Lane
) => {
  const what = `${text.subject ?? "(no subject)"} from ${text.sender ?? "an email"} (#${number})`;
  if (lane === "filtered") {
    return `Filtered out ${what}: not a request for quote.`;
  }
  if (lane === "po") {
    return `Customer PO: ${text.subject ?? "(no subject)"} from ${text.sender ?? "an email"} (PO-${String(number).padStart(4, "0")}), ready to check and enter in your ERP.`;
  }
  return lane === "new_sender"
    ? `New sender: ${what}, waiting for someone to say whether to quote it.`
    : `RFQ: ${what}`;
};

/** The sync note for an RFQ that's already in Takumo (the same request this week). */
export const sameRfqNote = (
  text: { sender: string | null; subject: string | null },
  number: number
) =>
  `Skipped ${text.subject ?? "a message"} from ${text.sender ?? "an unknown sender"}: the same request as ${rfqLabel(number)}, received in the last week.`;

/** Why a fetched message isn't read into an RFQ, or null to read it. */
export const skipReason = async (
  orgId: string,
  from: string | null,
  allowed: string[] | null,
  mail: MailThread
) => {
  if (!senderPasses(from, allowed)) {
    return `Skipped mail from ${from ?? "an unknown sender"}: not a sender your RFQ rules allow.`;
  }
  const number = await alreadyHave(orgId, mail);
  return number === null
    ? null
    : `Skipped a reply in the thread of RFQ #${number}: same attachments, so the same request.`;
};

/** One fetched mailbox message, ready to read into an RFQ. */
export interface MailboxMessage {
  /** Who may send RFQs (Gmail's rules); null: already checked. */
  allowed: string[] | null;
  bytes: Uint8Array;
  id: string;
  /** How the message is named in sync notes. */
  label: string;
  /** The mailbox it came from (a shared one for Outlook). */
  mailbox: string | null;
  threadId: string | null;
}

/** Read one message into an RFQ (or skip it), noting what happened. */
export const intakeMessage = async (
  orgId: string,
  connection: ConnectionRow,
  provider: "gmail" | "outlook",
  message: MailboxMessage,
  result: SyncResult
) => {
  try {
    // Inside the try: a malformed message is noted, not the end of the check.
    const { from, attachmentsHash } = fingerprint(message.bytes);
    const mail: MailThread = {
      provider,
      threadId: message.threadId,
      attachmentsHash,
    };
    const skip = await skipReason(orgId, from, message.allowed, mail);
    if (skip) {
      result.skipped += 1;
      result.notes.push(skip);
      return;
    }
    const text = await readRfqFile("message.eml", message.bytes);
    const rfq = await intakeRfq(orgId, connection.createdBy, text, {
      sourceId: message.id,
      mail,
      screen: { account: message.mailbox, settings: connection.settings },
    });
    if (rfq.duplicate) {
      result.skipped += 1;
      result.notes.push(sameRfqNote(text, rfq.number));
      return;
    }
    track("rfq_received", {
      orgId,
      properties: { source: provider, channel: text.source, lane: rfq.lane },
    });
    result.created += 1;
    result.notes.push(laneNote(text, rfq.number, rfq.lane));
  } catch (error) {
    result.skipped += 1;
    result.notes.push(
      `Couldn't read ${message.label}: ${error instanceof Error ? error.message : "error"}`
    );
  }
};
