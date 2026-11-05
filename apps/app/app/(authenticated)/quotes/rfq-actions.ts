"use server";

import { auth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { log } from "@repo/observability/log";
import type { z } from "zod";
import { authorize } from "@/lib/access";
import { track } from "@/lib/analytics";
import { featureProblem } from "@/lib/billing";
import { intakeRfq, readRfq, startFullWork } from "@/lib/quotes/intake";
import { matchCustomer } from "@/lib/quotes/match";
import { learnSender } from "@/lib/quotes/screening";
import { rfqLabel } from "@/lib/quotes/types";
import { keepUploadPart } from "@/lib/quotes/upload-parts";
import {
  EDITABLE,
  firstIssue,
  loadRfq,
  type Result,
  RfqFields,
  refresh,
  rfqFromForm,
  type SubmitResult,
  WAITING,
  withScreen,
} from "./action-helpers";

/** One piece of a large upload (the host caps each request at 4.5 MB). */
export const uploadRfqPart = async (form: FormData): Promise<Result> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const blob = form.get("part");
  if (!(blob instanceof Blob)) {
    return { ok: false, error: "That upload isn't valid. Try again." };
  }
  const problem = await keepUploadPart(
    access.orgId,
    {
      uploadId: String(form.get("uploadId") ?? ""),
      fileIndex: Number(form.get("fileIndex")),
      partIndex: Number(form.get("partIndex")),
      name: String(form.get("name") ?? ""),
    },
    new Uint8Array(await blob.arrayBuffer())
  );
  return problem ? { ok: false, error: problem } : { ok: true };
};

/**
 * A new RFQ from an uploaded package, pasted text or a call. Read straight
 * away; the same request within a week (same sender and files, or the same
 * text) links to the earlier RFQ.
 */
export const submitRfq = async (form: FormData): Promise<SubmitResult> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const locked = await featureProblem(access.orgId, "quotes");
  if (locked) {
    return { ok: false, error: locked };
  }
  const { userId } = await auth();
  try {
    const text = await rfqFromForm(access.orgId, form);
    if ("error" in text) {
      return { ok: false, error: text.error };
    }
    if (text.body.trim().length < 10 && text.files.length === 0) {
      return {
        ok: false,
        error:
          "Takumo couldn't find any text in that RFQ. If it's a scanned PDF, paste the text instead.",
      };
    }
    const rfq = await intakeRfq(access.orgId, userId, text, {
      fileName: text.files.length === 1 ? (text.files[0]?.name ?? null) : null,
    });
    if (rfq.duplicate) {
      return {
        ok: false,
        error: `This is the same as ${rfqLabel(rfq.number)}: the same request, received in the last week.`,
        existing: { id: rfq.id, label: rfqLabel(rfq.number) },
      };
    }
    track("rfq_received", {
      orgId: access.orgId,
      userId,
      properties: { source: text.source, files: text.files.length },
    });
    refresh(rfq.id);
    return { ok: true, id: rfq.id };
  } catch (error) {
    log.warn("RFQ intake failed", { error: String(error) });
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Couldn't read that RFQ.",
    };
  }
};

/** Read the RFQ again (replaces its lines). */
export const rereadRfq = async (rfqId: string): Promise<Result> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const locked = await featureProblem(access.orgId, "quotes");
  if (locked) {
    return { ok: false, error: locked };
  }
  const rfq = await loadRfq(access.orgId, rfqId);
  if (!(rfq && EDITABLE.includes(rfq.status))) {
    return { ok: false, error: "This RFQ can't be read again." };
  }
  const claimed = await forOrg(database, access.orgId).rfq.updateMany({
    where: { id: rfqId, status: { in: EDITABLE } },
    data: { status: "reading", error: null },
  });
  if (claimed.count === 0) {
    return { ok: false, error: "This RFQ can't be read again." };
  }
  await readRfq(access.orgId, rfqId);
  refresh(rfqId);
  return { ok: true };
};

/**
 * Screening's three answers for an RFQ waiting in the inbox: quote it
 * (Takumo reads, prices and drafts it, and knows the sender next time), not
 * an RFQ, or block the sender for good.
 */
export const screenRfq = async (
  rfqId: string,
  answer: "quote" | "not_rfq" | "block"
): Promise<Result> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const db = forOrg(database, access.orgId);
  const rfq = await db.rfq.findFirst({
    where: { id: rfqId },
    select: { status: true, sender: true, extracted: true },
  });
  if (!(rfq && WAITING.includes(rfq.status))) {
    return { ok: false, error: "This RFQ isn't waiting for a decision." };
  }
  if (answer === "quote") {
    const locked = await featureProblem(access.orgId, "quotes");
    if (locked) {
      return { ok: false, error: locked };
    }
    const claimed = await db.rfq.updateMany({
      where: { id: rfqId, status: { in: WAITING } },
      data: {
        status: "reading",
        error: null,
        extracted: withScreen(
          rfq.extracted,
          "full",
          "Someone chose to quote it."
        ),
      },
    });
    if (claimed.count === 0) {
      return { ok: false, error: "This RFQ isn't waiting for a decision." };
    }
    await learnSender(access.orgId, rfq.sender, "knownSenders");
    await startFullWork(access.orgId, rfqId);
  } else {
    if (answer === "block") {
      await learnSender(access.orgId, rfq.sender, "blockedSenders");
    }
    await db.rfq.updateMany({
      where: { id: rfqId, status: { in: WAITING } },
      data: {
        status: "filtered",
        extracted: withScreen(
          rfq.extracted,
          "filtered",
          answer === "block"
            ? "You blocked this sender."
            : "Marked as not a request for quote."
        ),
      },
    });
  }
  refresh(rfqId);
  return { ok: true };
};

export const updateRfq = async (
  rfqId: string,
  values: z.input<typeof RfqFields>
): Promise<Result> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const parsed = RfqFields.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }
  const rfq = await loadRfq(access.orgId, rfqId);
  if (!(rfq && EDITABLE.includes(rfq.status))) {
    return {
      ok: false,
      error: "This RFQ has been quoted and can't be changed.",
    };
  }
  const db = forOrg(database, access.orgId);
  const customers = await db.customer.findMany({
    select: { id: true, name: true },
  });
  const v = parsed.data;
  await db.rfq.updateMany({
    where: { id: rfqId },
    data: {
      customerName: v.customerName || null,
      customerId: matchCustomer(v.customerName, customers)?.id ?? null,
      contact: v.contact || null,
      requestedDate: v.requestedDate ? new Date(v.requestedDate) : null,
      notes: v.notes || null,
      status: rfq.status === "failed" ? "review" : rfq.status,
    },
  });
  refresh(rfqId);
  return { ok: true };
};

/** No quote: the shop passes on this RFQ (or reopens one it passed on). */
export const setDeclined = async (
  rfqId: string,
  declined: boolean
): Promise<Result> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const db = forOrg(database, access.orgId);
  const rfq = await db.rfq.findFirst({
    where: { id: rfqId },
    select: { status: true, lines: { select: { draft: true } } },
  });
  if (!rfq) {
    return { ok: false, error: "That RFQ no longer exists." };
  }
  if (declined ? !EDITABLE.includes(rfq.status) : rfq.status !== "declined") {
    return { ok: false, error: "This RFQ has already been quoted." };
  }
  const reopened =
    rfq.lines.length && rfq.lines.every((l) => l.draft) ? "drafted" : "review";
  const changed = await db.rfq.updateMany({
    where: { id: rfqId, status: declined ? { in: EDITABLE } : "declined" },
    data: { status: declined ? "declined" : reopened },
  });
  if (changed.count === 0) {
    return { ok: false, error: "This RFQ has already been quoted." };
  }
  refresh(rfqId);
  return { ok: true };
};

/** Delete an RFQ that hasn't been quoted. */
export const deleteRfq = async (rfqId: string): Promise<Result> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const rfq = await loadRfq(access.orgId, rfqId);
  if (!rfq) {
    return { ok: true };
  }
  if (
    !["review", "drafted", "failed", "declined", "reading"].includes(rfq.status)
  ) {
    return { ok: false, error: "Quoted RFQs are kept with their quotes." };
  }
  await forOrg(database, access.orgId).rfq.deleteMany({ where: { id: rfqId } });
  refresh();
  return { ok: true };
};
