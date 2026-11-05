import "server-only";
import { database, forOrg } from "@repo/database";
import { log } from "@repo/observability/log";
import { budgetProblem } from "../ai-usage";
import { notifyMember } from "../notify";
import { htmlToText } from "./email";
import { estimateRfqLines } from "./estimate-rfq";
import {
  buildContent,
  DRAFT_STATUSES,
  type DraftAction,
  type DraftMode,
  findTarget,
  hash,
  OPEN_STATUSES,
  type Result,
  reserveNumbers,
  type Target,
  today,
} from "./mailbox-target";
import {
  createInMailbox,
  mailboxText,
  removeDraft,
  type Written,
} from "./mailbox-write";
import { draftStep, normalizeBody, updatedDraftText } from "./reply";
import { type RfqReply, rfqLabel } from "./types";
import { loadRfqView, type RfqView } from "./view";

// The draft reply in the customer's email thread (docs/PRODUCT-PLAN.md F2.5).
// Takumo only ever writes drafts; the estimator sends them.

const notifyDraftReady = async (
  orgId: string,
  rfq: {
    createdBy: string | null;
    customerName: string | null;
    id: string;
    number: number;
  },
  reply: RfqReply,
  counts: { lines: number; questions: number },
  action: DraftAction
) => {
  const { lines, questions } = counts;
  const label = rfqLabel(rfq.number);
  let where = `It's in your ${reply.provider === "gmail" ? "Gmail" : "Outlook"} drafts${reply.inThread ? ", in the customer's thread" : ""}.`;
  if (reply.pdfOnly) {
    where = "The quote PDF is ready to send.";
  } else if (action === "added") {
    where = updatedDraftText(reply);
  }
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
    await notifyDraftReady(
      orgId,
      rfq,
      reply,
      { lines: built.lineCount, questions },
      outcome.action
    );
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
