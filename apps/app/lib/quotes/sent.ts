import "server-only";

import { database, forOrg } from "@repo/database";
import { log } from "@repo/observability/log";
import { track } from "../analytics";
import {
  rawMessage as gmailRawMessage,
  sentInThread,
} from "../connectors/gmail";
import { sentInConversation } from "../connectors/outlook";
import { sentFinal } from "./approval";
import { approveRfq } from "./approve";
import { htmlToText, parseEmail } from "./email";
import { parseSentPrices } from "./reply";
import {
  type QuotedBreak,
  type RfqReply,
  rfqLabel,
  type SentPrice,
} from "./types";

// When the estimator sends Takumo's draft (edited or not) from their mailbox,
// the RFQ becomes "quoted" with the prices they actually sent, so the draft
// can be compared with what went out (docs/PRODUCT-PLAN.md F2.5-R5, F2.7).

const DAY_MS = 86_400_000;
/** Drafts older than this aren't watched for a reply any more. */
const WATCH_DAYS = 60;
const MAX_WATCHED = 50;

/** Already-approved quotes: the sent prices replace the approved ones. */
const updateQuotedPrices = async (
  orgId: string,
  lines: { partNo: string | null; quoteId: string | null; qtys: number[] }[],
  prices: SentPrice[]
) => {
  const db = forOrg(database, orgId);
  for (const line of lines) {
    if (!line.quoteId) {
      continue;
    }
    const quote = await db.quote.findFirst({ where: { id: line.quoteId } });
    if (!quote || quote.status !== "open") {
      continue;
    }
    const partNo = line.partNo?.trim().toLowerCase();
    const breaks = ((quote.breaks as QuotedBreak[] | null) ?? []).map((b) => {
      const sent = prices.find(
        (p) => p.partNo.toLowerCase() === partNo && p.qty === b.qty
      );
      return sent
        ? {
            ...b,
            unitPrice: sent.unitPrice,
            price: Math.round(sent.unitPrice * b.qty * 100) / 100,
            leadTimeDays: sent.leadTimeDays ?? b.leadTimeDays,
          }
        : b;
    });
    const headline = breaks.find((b) => b.qty === quote.qty);
    await db.quote.updateMany({
      where: { id: quote.id, status: "open" },
      data: {
        breaks: breaks as object[],
        ...(headline
          ? { price: headline.price, leadTimeDays: headline.leadTimeDays }
          : {}),
      },
    });
  }
};

/**
 * Record that the reply went out: sentAt, the prices read from it, and (for
 * an RFQ not yet approved) the quotes, approved with the sent prices. When a
 * line's prices can't be read from the email, the RFQ waits for the
 * estimator to approve it in Takumo. Returns a note for the sync result.
 */
export const recordSent = async (
  orgId: string,
  rfqId: string,
  sent: { at: Date; messageId: string; text: string }
) => {
  const db = forOrg(database, orgId);
  const rfq = await db.rfq.findFirst({
    where: { id: rfqId },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  const reply = rfq?.reply as RfqReply | null;
  if (!(rfq && reply) || reply.sent) {
    return null;
  }
  const label = rfqLabel(rfq.number);
  const prices = parseSentPrices(
    sent.text,
    rfq.lines.map((l) => l.partNo ?? "")
  );
  const claimed = await db.rfq.updateMany({
    where: { id: rfq.id, sentAt: null },
    data: {
      sentAt: sent.at,
      reply: {
        ...reply,
        sent: {
          at: sent.at.toISOString(),
          messageId: sent.messageId,
          prices,
        },
      } satisfies RfqReply as object,
    },
  });
  if (claimed.count === 0) {
    return null;
  }
  track("reply_sent", {
    orgId,
    properties: { lines: rfq.lines.length, pricesRead: prices.length },
  });
  if (rfq.status === "quoted") {
    await updateQuotedPrices(orgId, rfq.lines, prices);
    return `${label}: the reply was sent; its prices are on the quotes.`;
  }
  if (!["review", "drafted"].includes(rfq.status)) {
    return null;
  }
  const finals = rfq.lines.map((line) => ({
    line,
    final: sentFinal(line, prices),
  }));
  if (finals.some((f) => f.final === null)) {
    await db.rfq.updateMany({
      where: { id: rfq.id },
      data: {
        reply: {
          ...reply,
          sent: {
            at: sent.at.toISOString(),
            messageId: sent.messageId,
            prices,
          },
          note: "The reply was sent, but Takumo couldn't read every price in it. Check the prices and approve the quote.",
        } satisfies RfqReply as object,
      },
    });
    return `${label}: the reply was sent; approve it in Takumo to record the prices.`;
  }
  for (const { line, final } of finals) {
    await db.rfqLine.updateMany({
      where: { id: line.id },
      data: { final: final as object },
    });
  }
  const approved = await approveRfq(orgId, rfq.createdBy ?? "mailbox", rfq.id);
  return approved.ok
    ? `${label}: the reply was sent; quoted as ${approved.quoteNos.join(", ")}.`
    : `${label}: the reply was sent, but the quote couldn't be recorded: ${approved.error}`;
};

type Provider = "gmail" | "outlook";

/** The reply sent in a draft's thread after the draft was made, as text. */
const findSent = async (
  provider: Provider,
  token: string,
  reply: RfqReply,
  sharedMailbox: string | null
) => {
  if (!reply.threadId) {
    return null;
  }
  const after = new Date(reply.createdAt);
  if (provider === "gmail") {
    const sent = await sentInThread(fetch, token, reply.threadId, after);
    if (!sent) {
      return null;
    }
    const raw = await gmailRawMessage(fetch, token, sent.id);
    return {
      at: sent.at,
      messageId: sent.id,
      text: parseEmail(new TextDecoder().decode(raw)).body,
    };
  }
  const sent = await sentInConversation(
    fetch,
    token,
    reply.threadId,
    after,
    sharedMailbox
  );
  return sent
    ? { at: sent.at, messageId: sent.id, text: htmlToText(sent.html) }
    : null;
};

const sharedMailboxOf = (settings: unknown) => {
  const shared =
    settings && typeof settings === "object"
      ? (settings as { sharedMailbox?: unknown }).sharedMailbox
      : null;
  return typeof shared === "string" && shared ? shared : null;
};

/**
 * After a mailbox check: look for replies sent to RFQs whose draft is in this
 * mailbox and record them. Never throws; returns notes for the sync result.
 */
export const checkSentReplies = async (
  orgId: string,
  provider: Provider,
  connection: { settings: unknown },
  token: () => Promise<string>
): Promise<string[]> => {
  try {
    const watched = await forOrg(database, orgId).rfq.findMany({
      where: {
        sentAt: null,
        status: { in: ["review", "drafted", "quoted"] },
        draftedAt: { gte: new Date(Date.now() - WATCH_DAYS * DAY_MS) },
        reply: { path: ["provider"], equals: provider },
      },
      orderBy: { draftedAt: "desc" },
      take: MAX_WATCHED,
      select: { id: true, reply: true },
    });
    if (watched.length === 0) {
      return [];
    }
    const access = await token();
    const shared =
      provider === "outlook" ? sharedMailboxOf(connection.settings) : null;
    const notes: string[] = [];
    for (const rfq of watched) {
      const reply = rfq.reply as RfqReply | null;
      if (!reply || reply.pdfOnly || reply.sent) {
        continue;
      }
      try {
        const sent = await findSent(provider, access, reply, shared);
        if (!sent) {
          continue;
        }
        const note = await recordSent(orgId, rfq.id, sent);
        if (note) {
          notes.push(note);
        }
      } catch (error) {
        log.warn("Checking a sent reply failed", {
          orgId,
          rfqId: rfq.id,
          error: String(error),
        });
      }
    }
    return notes;
  } catch (error) {
    log.warn("Checking sent replies failed", { orgId, error: String(error) });
    return [];
  }
};
