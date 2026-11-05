// Where a reply draft goes: the mailbox, thread and headers, and reserved quote numbers.

import "server-only";

import { createHash } from "node:crypto";
import { database, forOrg, Prisma } from "@repo/database";
import { mailboxAccess } from "../connectors/sync";
import { mailThreadOf } from "../connectors/thread";
import { domainOf, emailAddress } from "../inbound/verify";
import { customerReply, quoteDocument } from "./document";
import { nextNumber } from "./numbers";
import { renderQuotePdf } from "./pdf";
import { customerAddress } from "./reply";
import { quoteSettings } from "./settings";
import type { RfqReply } from "./types";
import type { RfqView } from "./view";

export type Provider = "gmail" | "outlook";

export type DraftMode = "auto" | "explicit";

export type DraftAction =
  | "created"
  | "replaced"
  | "added"
  | "unchanged"
  | "pdf_only"
  | "skipped";

export type Result =
  | { ok: true; action: DraftAction; reply: RfqReply | null }
  | { ok: false; error: string };

export const OPEN_STATUSES = ["review", "drafted"];

export const DRAFT_STATUSES = ["review", "drafted", "quoted"];

export const today = () => new Date().toISOString().slice(0, 10);

export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/**
 * Quote numbers for the draft: approved lines keep their quote's, others keep
 * the number they were given before, new lines take the next free one (not
 * used by any quote or by another RFQ's draft).
 */
export const reserveNumbers = async (
  orgId: string,
  view: RfqView,
  before: Record<string, string>
) => {
  const numbers: Record<string, string> = {};
  const need: string[] = [];
  for (const line of view.lines) {
    if (line.quote) {
      numbers[line.id] = line.quote.quoteNo;
    } else if (before[line.id]) {
      numbers[line.id] = before[line.id];
    } else {
      need.push(line.id);
    }
  }
  if (need.length === 0) {
    return numbers;
  }
  const db = forOrg(database, orgId);
  const [quotes, drafts] = await Promise.all([
    db.quote.findMany({ select: { quoteNo: true } }),
    db.rfq.findMany({
      where: {
        id: { not: view.id },
        status: { in: OPEN_STATUSES },
        reply: { not: Prisma.DbNull },
      },
      select: { reply: true },
    }),
  ]);
  const taken = [
    ...quotes.map((q) => q.quoteNo),
    ...drafts.flatMap((d) =>
      Object.values((d.reply as RfqReply | null)?.quoteNos ?? {})
    ),
    ...Object.values(numbers),
  ];
  for (const id of need) {
    const next = nextNumber(taken, "Q-0001");
    taken.push(next);
    numbers[id] = next;
  }
  return numbers;
};

/** What the customer gets: the email text and the quote PDF. */
export const buildContent = async (
  orgId: string,
  view: RfqView,
  reserved: Record<string, string>
) => {
  const [settings, org] = await Promise.all([
    quoteSettings(orgId),
    database.org.findUnique({ where: { id: orgId }, select: { name: true } }),
  ]);
  const shop = org?.name ?? "Our shop";
  const content = customerReply(view, shop, settings, reserved);
  if (!content) {
    throw new Error("No line has a price yet.");
  }
  const doc = quoteDocument(view, shop, {
    reserved,
    today: today(),
    validityDays: settings.quoteValidityDays,
  });
  const pdf = {
    name: `Quote ${doc.reference}.pdf`,
    mediaType: "application/pdf",
    bytes: new Uint8Array(await renderQuotePdf(doc)),
  };
  return { content, pdf, lineCount: content.lines.length };
};

export const HEADER_END = /\r?\n\r?\n/;

export const FOLDED = /\r?\n[ \t]+/g;

/** Message-ID, References, Reply-To and From of a raw message. */
export const replyHeaders = (raw: Uint8Array) => {
  const text = new TextDecoder().decode(raw);
  const head = text.slice(0, text.search(HEADER_END)).replace(FOLDED, " ");
  const get = (name: string) =>
    head.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim() ?? null;
  return {
    messageId: get("Message-ID"),
    references: get("References"),
    replyTo: get("Reply-To"),
    from: get("From"),
  };
};

export interface Target {
  connection: NonNullable<Awaited<ReturnType<typeof mailboxAccess>>>;
  /** In the RFQ's thread (its message id), or a new message to `to`. */
  inThread: string | null;
  provider: Provider;
  /**
   * The thread's message isn't from the customer (a colleague's forward, a
   * portal's no-reply notice): the draft goes to `to`, the customer.
   */
  redirect?: boolean;
  sharedMailbox: string | null;
  threadId: string | null;
  to: string | null;
}

export const sharedMailboxOf = (settings: unknown) => {
  const shared =
    settings && typeof settings === "object"
      ? (settings as { sharedMailbox?: unknown }).sharedMailbox
      : null;
  return typeof shared === "string" && shared ? shared : null;
};

/** Whether an address is at the shop's own domain (the mailbox's). */
export const fromShop = (address: string | null, mailbox: string | null) => {
  const from = emailAddress(address);
  return Boolean(
    from && mailbox && domainOf(from) === domainOf(mailbox.toLowerCase())
  );
};

/**
 * Where the draft goes: the mailbox the RFQ came from (in its thread), else a
 * new message to the customer from whichever mailbox is connected. A reason
 * instead when there's no mailbox to put it in, or no customer address.
 */
export const findTarget = async (
  orgId: string,
  rfq: {
    contact: string | null;
    extracted: unknown;
    sender: string | null;
    source: string;
    sourceId: string | null;
  }
): Promise<Target | { reason: string }> => {
  const mail = mailThreadOf(rfq.extracted);
  if (mail && rfq.sourceId) {
    const access = await mailboxAccess(orgId, mail.provider);
    if (access) {
      return {
        connection: access,
        provider: mail.provider,
        inThread: rfq.sourceId,
        threadId: mail.threadId,
        to: customerAddress(rfq, access.connection.account),
        // A colleague's forward, or a portal or website form's notification
        // (a no-reply address): the reply goes to the customer instead.
        redirect:
          fromShop(rfq.sender, access.connection.account) ||
          rfq.source === "portal" ||
          rfq.source === "form",
        sharedMailbox: sharedMailboxOf(access.connection.settings),
      };
    }
  }
  for (const provider of ["outlook", "gmail"] as const) {
    const access = await mailboxAccess(orgId, provider);
    if (access) {
      const to = customerAddress(rfq, access.connection.account);
      if (!to) {
        return {
          reason:
            "There's no email address for this customer, so the quote is a PDF to send yourself.",
        };
      }
      return {
        connection: access,
        provider,
        inThread: null,
        threadId: null,
        to,
        sharedMailbox:
          provider === "outlook"
            ? sharedMailboxOf(access.connection.settings)
            : null,
      };
    }
  }
  return {
    reason:
      "No mailbox is connected, so the quote is a PDF to send yourself. Connect Outlook or Gmail under Settings → Integrations to get drafts in your mailbox.",
  };
};
