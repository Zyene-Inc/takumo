import "server-only";

import { createHash } from "node:crypto";
import { database, forOrg, Prisma } from "@repo/database";
import { log } from "@repo/observability/log";
import { budgetProblem } from "../ai-usage";
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
import { mailboxAccess } from "../connectors/sync";
import { mailThreadOf } from "../connectors/thread";
import { domainOf, emailAddress } from "../inbound/verify";
import { notifyMember } from "../notify";
import { customerReply, quoteDocument } from "./document";
import { htmlToText, parseEmail } from "./email";
import { estimateRfqLines } from "./estimate-rfq";
import { nextNumber } from "./numbers";
import { renderQuotePdf } from "./pdf";
import { customerAddress, draftStep, normalizeBody } from "./reply";
import { quoteSettings } from "./settings";
import { type RfqReply, rfqLabel } from "./types";
import { loadRfqView, type RfqView } from "./view";

// The draft reply in the customer's email thread (docs/PRODUCT-PLAN.md F2.5).
// Takumo only ever writes drafts; the estimator sends them.

type Provider = "gmail" | "outlook";
export type DraftMode = "auto" | "explicit";
export type DraftAction =
  | "created"
  | "replaced"
  | "added"
  | "unchanged"
  | "pdf_only"
  | "skipped";

type Result =
  | { ok: true; action: DraftAction; reply: RfqReply | null }
  | { ok: false; error: string };

const OPEN_STATUSES = ["review", "drafted"];
const DRAFT_STATUSES = ["review", "drafted", "quoted"];

const today = () => new Date().toISOString().slice(0, 10);

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Quote numbers for the draft: approved lines keep their quote's, others keep
 * the number they were given before, new lines take the next free one (not
 * used by any quote or by another RFQ's draft).
 */
const reserveNumbers = async (
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
const buildContent = async (
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

const HEADER_END = /\r?\n\r?\n/;
const FOLDED = /\r?\n[ \t]+/g;

/** Message-ID, References, Reply-To and From of a raw message. */
const replyHeaders = (raw: Uint8Array) => {
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

interface Target {
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

const sharedMailboxOf = (settings: unknown) => {
  const shared =
    settings && typeof settings === "object"
      ? (settings as { sharedMailbox?: unknown }).sharedMailbox
      : null;
  return typeof shared === "string" && shared ? shared : null;
};

/** Whether an address is at the shop's own domain (the mailbox's). */
const fromShop = (address: string | null, mailbox: string | null) => {
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
const findTarget = async (
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

interface Written {
  draftId: string;
  messageId: string | null;
  threadId: string | null;
}

/**
 * A Gmail draft in the RFQ's thread, or null when the thread can't take one
 * (no Message-ID, no address): then it's a new message.
 */
const gmailInThread = async (
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
const createInMailbox = async (
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
const mailboxText = async (target: Target, draftId: string) => {
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

const removeDraft = (target: Target, draftId: string) =>
  target.provider === "gmail"
    ? gmailDeleteDraft(fetch, target.connection.token, draftId)
    : outlookDelete(
        fetch,
        target.connection.token,
        draftId,
        target.sharedMailbox
      );

const notifyDraftReady = async (
  orgId: string,
  rfq: {
    createdBy: string | null;
    customerName: string | null;
    id: string;
    number: number;
  },
  reply: RfqReply,
  lines: number,
  questions: number
) => {
  const label = rfqLabel(rfq.number);
  const where = reply.pdfOnly
    ? "The quote PDF is ready to send."
    : `It's in your ${reply.provider === "gmail" ? "Gmail" : "Outlook"} drafts${reply.inThread ? ", in the customer's thread" : ""}.`;
  await notifyMember(
    orgId,
    [rfq.createdBy],
    `Draft ready for ${label}${rfq.customerName ? ` from ${rfq.customerName}` : ""}`,
    [
      `Draft ready for ${label}${rfq.customerName ? ` from ${rfq.customerName}` : ""}: ${lines} line${lines === 1 ? "" : "s"}, ${questions} question${questions === 1 ? "" : "s"}.`,
      where,
      "Check it, edit anything, and send it from your mailbox. Takumo never sends it for you.",
      "Review:",
    ],
    `/quotes/${rfq.id}`
  );
};

interface MailboxOutcome {
  action: DraftAction;
  note: string | null;
  replaced: number;
  written: Written | null;
}

/** Apply the draft step (F2.5-R4) to the mailbox. */
const applyStep = async (
  target: Target,
  before: RfqReply | null,
  mode: DraftMode,
  built: Awaited<ReturnType<typeof buildContent>>,
  bodyText: string,
  subject: string | null
): Promise<MailboxOutcome> => {
  const sameMailbox = Boolean(
    before?.draftId && before.provider === target.provider
  );
  const draftId = before?.draftId as string;
  const step = draftStep({
    mode,
    before: sameMailbox ? (before?.bodyText ?? null) : null,
    current: sameMailbox ? await mailboxText(target, draftId) : null,
    next: bodyText,
  });
  const replaced = before?.replaced ?? 0;
  const write = (suffix: string) =>
    createInMailbox(target, built.content, built.pdf, suffix, subject);
  switch (step) {
    case "skip":
      // Deleted or sent by the estimator: leave it alone.
      return { action: "skipped", note: null, replaced, written: null };
    case "unchanged":
      return { action: "unchanged", note: null, replaced, written: null };
    case "replace":
      await removeDraft(target, draftId);
      return {
        action: "replaced",
        note: null,
        replaced: replaced + 1,
        written: await write(""),
      };
    case "add":
      // The estimator edited it: keep theirs, add the new one beside it.
      return {
        action: "added",
        note: null,
        replaced,
        written: await write(" (updated)"),
      };
    default:
      return {
        action: "created",
        note: null,
        replaced,
        written: await write(""),
      };
  }
};

/** Put the draft in the mailbox, or say why it's a PDF only. Never throws. */
const toMailbox = async (
  orgId: string,
  rfqId: string,
  target: Target | { reason: string },
  ...args: [
    RfqReply | null,
    DraftMode,
    Awaited<ReturnType<typeof buildContent>>,
    string,
    string | null,
  ]
): Promise<MailboxOutcome> => {
  const replaced = args[0]?.replaced ?? 0;
  if ("reason" in target) {
    return { action: "pdf_only", note: target.reason, replaced, written: null };
  }
  try {
    return await applyStep(target, ...args);
  } catch (error) {
    log.warn("Writing a reply draft failed", {
      orgId,
      rfqId,
      error: String(error),
    });
    return {
      action: "pdf_only",
      note:
        error instanceof Error
          ? `Takumo couldn't put the draft in your mailbox: ${error.message}`
          : "Takumo couldn't put the draft in your mailbox.",
      replaced,
      written: null,
    };
  }
};

/** What's kept on Rfq.reply after writing the draft. */
const replyRecord = (
  target: Target | { reason: string },
  outcome: MailboxOutcome,
  before: RfqReply | null,
  draft: { bodyText: string; quoteNos: Record<string, string>; subject: string }
): RfqReply => {
  const now = new Date().toISOString();
  const placed = "reason" in target ? null : target;
  const written = outcome.written;
  return {
    provider: written && placed ? placed.provider : "none",
    mailbox:
      written && placed
        ? (placed.sharedMailbox ?? placed.connection.connection.account)
        : null,
    draftId: written?.draftId ?? null,
    messageId: written?.messageId ?? null,
    threadId: written?.threadId ?? null,
    inThread: Boolean(written && placed?.inThread),
    to: placed?.to ?? null,
    subject: draft.subject,
    bodyHash: hash(draft.bodyText),
    bodyText: draft.bodyText,
    quoteNos: draft.quoteNos,
    createdAt: written ? now : (before?.createdAt ?? now),
    updatedAt: now,
    replaced: outcome.replaced,
    pdfOnly: !written,
    note: outcome.note,
    sent: null,
  };
};

const RFQ_FOR_DRAFT = {
  id: true,
  number: true,
  status: true,
  source: true,
  sourceId: true,
  sender: true,
  contact: true,
  customerName: true,
  createdBy: true,
  extracted: true,
  reply: true,
  draftedAt: true,
  sentAt: true,
} as const;

/** Why the RFQ can't have a draft reply yet, or null. */
const notDraftable = (
  rfq: { sentAt: Date | null; status: string },
  view: RfqView
) => {
  if (!DRAFT_STATUSES.includes(rfq.status)) {
    return "This RFQ is closed.";
  }
  if (rfq.sentAt) {
    return "The reply has already been sent.";
  }
  if (
    view.lines.length === 0 ||
    view.lines.some((l) => !(l.quote || l.sendFinal))
  ) {
    return "Every line needs a price before Takumo can draft the reply.";
  }
  return null;
};

/**
 * Write (or refresh) the RFQ's draft reply. `auto` runs after an estimate:
 * an existing draft is replaced only if the estimator hasn't edited it, an
 * edited one gets a second "(updated)" draft beside it, and a deleted or sent
 * one is left alone. `explicit` (the estimator's button) also makes a fresh
 * draft when the old one is gone.
 */
export const writeReplyDraft = async (
  orgId: string,
  rfqId: string,
  mode: DraftMode,
  options: { notify?: boolean } = {}
): Promise<Result> => {
  const db = forOrg(database, orgId);
  const rfq = await db.rfq.findFirst({
    where: { id: rfqId },
    select: RFQ_FOR_DRAFT,
  });
  const view = rfq ? await loadRfqView(orgId, rfqId) : null;
  if (!(rfq && view)) {
    return { ok: false, error: "That RFQ no longer exists." };
  }
  const problem = notDraftable(rfq, view);
  if (problem) {
    return { ok: false, error: problem };
  }
  const before = rfq.reply as RfqReply | null;
  const quoteNos = await reserveNumbers(orgId, view, before?.quoteNos ?? {});
  const built = await buildContent(orgId, view, quoteNos);
  const bodyText = normalizeBody(htmlToText(built.content.html));
  const target = await findTarget(orgId, rfq);
  const outcome = await toMailbox(
    orgId,
    rfqId,
    target,
    before,
    mode,
    built,
    bodyText,
    view.subject
  );
  if (outcome.action === "skipped" || outcome.action === "unchanged") {
    return { ok: true, action: outcome.action, reply: before };
  }
  const reply = replyRecord(target, outcome, before, {
    bodyText,
    quoteNos,
    subject: built.content.subject,
  });
  await db.rfq.updateMany({
    where: { id: rfq.id },
    data: {
      reply: reply as object,
      draftedAt: rfq.draftedAt ?? new Date(),
      ...(OPEN_STATUSES.includes(rfq.status) ? { status: "drafted" } : {}),
    },
  });
  if (options.notify ?? mode === "auto") {
    const questions =
      view.questions.length +
      view.lines.reduce((n, l) => n + (l.drawing?.questions?.length ?? 0), 0);
    await notifyDraftReady(orgId, rfq, reply, built.lineCount, questions);
  }
  return { ok: true, action: outcome.action, reply };
};

/**
 * Once an RFQ has been read: price every line, then draft the reply. Runs in
 * the background for RFQs that arrive by email; never throws.
 */
export const draftWhenReady = async (orgId: string, rfqId: string) => {
  try {
    const rfq = await forOrg(database, orgId).rfq.findFirst({
      where: { id: rfqId },
      select: {
        status: true,
        number: true,
        customerName: true,
        createdBy: true,
        _count: { select: { lines: true } },
      },
    });
    if (!(rfq && OPEN_STATUSES.includes(rfq.status) && rfq._count.lines)) {
      return;
    }
    // Estimating new parts uses AI: respect the shop's monthly budget.
    if (await budgetProblem(orgId)) {
      return;
    }
    const { drafted, total } = await estimateRfqLines(orgId, rfqId, today());
    if (drafted === total) {
      await writeReplyDraft(orgId, rfqId, "auto");
      return;
    }
    // Not silently: the estimator learns there's no draft, and why.
    const label = rfqLabel(rfq.number);
    const from = rfq.customerName ? ` from ${rfq.customerName}` : "";
    await notifyMember(
      orgId,
      [rfq.createdBy],
      `${label}${from} needs you before Takumo can draft the reply`,
      [
        `Takumo priced ${drafted} of ${total} line${total === 1 ? "" : "s"} of ${label}${from}, so there's no draft reply yet.`,
        "Open it to see what's missing on each line. Often it's a margin: with no won quotes to learn from yet, enter the margin you want, and Takumo drafts the reply.",
        "Review:",
      ],
      `/quotes/${rfqId}`
    );
  } catch (error) {
    log.warn("Drafting an RFQ reply failed", {
      orgId,
      rfqId,
      error: String(error),
    });
  }
};
