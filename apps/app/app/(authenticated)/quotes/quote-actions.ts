"use server";

import { auth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { authorize } from "@/lib/access";
import { track } from "@/lib/analytics";
import { featureProblem } from "@/lib/billing";
import { approveRfq, type Outcome, recordOutcome } from "@/lib/quotes/approve";
import { estimateRfqLines } from "@/lib/quotes/estimate-rfq";
import { writeReplyDraft } from "@/lib/quotes/mailbox-reply";
import { updatedDraftText } from "@/lib/quotes/reply";
import { checkToday } from "@/lib/schedule/request";
import { type Result, refresh, WRONG_DATE } from "./action-helpers";

/** Draft every line that doesn't have a draft yet (or all of them with `redo`). */
export const draftQuote = async (
  rfqId: string,
  today: string,
  redo = false
): Promise<Result<{ errors: string[] }>> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const locked = await featureProblem(access.orgId, "quotes");
  if (locked) {
    return { ok: false, error: locked };
  }
  const start = checkToday(today);
  if (!start) {
    return { ok: false, error: WRONG_DATE };
  }
  const rfq = await forOrg(database, access.orgId).rfq.findFirst({
    where: { id: rfqId },
    select: {
      status: true,
      lines: {
        orderBy: { lineNo: "asc" },
        select: { id: true, lineNo: true, draft: true },
      },
    },
  });
  if (!(rfq && ["review", "drafted"].includes(rfq.status))) {
    return { ok: false, error: "This RFQ can't be drafted." };
  }
  if (rfq.lines.length === 0) {
    return { ok: false, error: "Add at least one line first." };
  }
  const { drafted, total, attempted, errors } = await estimateRfqLines(
    access.orgId,
    rfqId,
    start,
    redo
  );
  track("quote_drafted", {
    orgId: access.orgId,
    properties: { lines: attempted, failed: errors.length },
  });
  if (drafted === total) {
    // The draft reply goes in the mailbox (or the PDF is made) meanwhile.
    const orgId = access.orgId;
    after(() =>
      writeReplyDraft(orgId, rfqId, "auto", { notify: false }).then(
        () => undefined
      )
    );
  }
  refresh(rfqId);
  return { ok: true, errors };
};

export const approve = async (
  rfqId: string
): Promise<Result<{ quoteNos: string[] }>> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const locked = await featureProblem(access.orgId, "quotes");
  if (locked) {
    return { ok: false, error: locked };
  }
  const { userId } = await auth();
  if (!userId) {
    return { ok: false, error: "Sign in again." };
  }
  const result = await approveRfq(access.orgId, userId, rfqId);
  if (result.ok) {
    track("quote_approved", {
      orgId: access.orgId,
      userId,
      properties: { quotes: result.quoteNos.length },
    });
  }
  refresh(rfqId);
  revalidatePath("/quotes/history");
  return result;
};

export const recordLineOutcome = async (
  rfqId: string,
  outcome: Outcome,
  today: string
): Promise<Result<{ orderNo: string | null }>> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const start = checkToday(today);
  if (!start) {
    return { ok: false, error: WRONG_DATE };
  }
  const result = await recordOutcome(access.orgId, rfqId, outcome, start);
  if (result.ok) {
    track("quote_outcome", {
      orgId: access.orgId,
      properties: { status: outcome.status },
    });
  }
  refresh(rfqId);
  revalidatePath("/quotes/history");
  revalidatePath("/shop/orders");
  return result;
};

/**
 * Put the reply draft in the mailbox now, or refresh it: an unedited draft is
 * replaced, an edited one gets an "(updated)" draft beside it, and a deleted
 * one is made again. Takumo never sends it.
 */
export const updateReplyDraft = async (
  rfqId: string
): Promise<Result<{ message: string }>> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const locked = await featureProblem(access.orgId, "quotes");
  if (locked) {
    return { ok: false, error: locked };
  }
  const result = await writeReplyDraft(access.orgId, rfqId, "explicit");
  refresh(rfqId);
  if (!result.ok) {
    return result;
  }
  const where =
    result.reply?.provider === "gmail" ? "Gmail drafts" : "Outlook drafts";
  const messages: Record<string, string> = {
    created: `The draft is in your ${where}. Check it and send it from there.`,
    replaced: `The draft in your ${where} now has the latest prices.`,
    added: result.reply
      ? updatedDraftText(result.reply)
      : "You'd edited the draft, so a new one is beside it.",
    unchanged: "The draft is already up to date.",
    pdf_only:
      result.reply?.note ??
      "The quote PDF is ready. Download it and send it with your reply.",
    skipped: "Nothing changed.",
  };
  track("reply_drafted", {
    orgId: access.orgId,
    properties: { action: result.action },
  });
  return { ok: true, message: messages[result.action] };
};
