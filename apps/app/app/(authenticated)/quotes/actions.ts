"use server";

import { auth } from "@repo/auth/server";
import { database, forOrg, Prisma } from "@repo/database";
import type { OutsideProcess, QuoteOperation } from "@repo/engine-client/types";
import { log } from "@repo/observability/log";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { authorize } from "@/lib/access";
import { track } from "@/lib/analytics";
import { featureProblem } from "@/lib/billing";
import { approveRfq, type Outcome, recordOutcome } from "@/lib/quotes/approve";
import { estimateLine } from "@/lib/quotes/estimate";
import { estimateRfqLines } from "@/lib/quotes/estimate-rfq";
import { intakeRfq, readRfq, startFullWork } from "@/lib/quotes/intake";
import { writeReplyDraft } from "@/lib/quotes/mailbox-reply";
import { matchCustomer, matchMaterial, matchPart } from "@/lib/quotes/match";
import { parseQtys } from "@/lib/quotes/numbers";
import {
  type RfqText,
  readCall,
  readPasted,
  readRfqUpload,
} from "@/lib/quotes/read";
import { updatedDraftText } from "@/lib/quotes/reply";
import { learnSender } from "@/lib/quotes/screening";
import { type LineFinal, MAX_QTY_BREAKS, rfqLabel } from "@/lib/quotes/types";
import { isUploadId, MAX_UPLOAD_BYTES } from "@/lib/quotes/upload-limits";
import { keepUploadPart, takeUpload } from "@/lib/quotes/upload-parts";
import { checkToday } from "@/lib/schedule/request";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const WRONG_DATE = "Your computer's date looks wrong; reload and try again.";

const refresh = (rfqId?: string) => {
  revalidatePath("/quotes");
  if (rfqId) {
    revalidatePath(`/quotes/${rfqId}`);
  }
};

const firstIssue = (error: z.ZodError) =>
  error.issues[0]?.message ?? "Check the form.";

/** Everything uploaded at once (the server action's body limit). */
const OVERRIDES = ["portal", "form"] as const;

const uploadedFiles = (orgId: string, form: FormData) => {
  // Large uploads come in pieces first (uploadRfqPart), then just their id.
  const uploadId = String(form.get("uploadId") ?? "");
  if (uploadId) {
    return isUploadId(uploadId) ? takeUpload(orgId, uploadId) : [];
  }
  return Promise.all(
    form
      .getAll("file")
      .filter((f): f is File => f instanceof File && f.size > 0)
      .map(async (f) => ({
        name: f.name,
        bytes: new Uint8Array(await f.arrayBuffer()),
      }))
  );
};

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

/** The RFQ's text and files from the form: an upload, a paste or a call. */
const rfqFromForm = async (
  orgId: string,
  form: FormData
): Promise<RfqText | { error: string }> => {
  const mode = String(form.get("mode") ?? "paste");
  const typed = String(form.get("text") ?? "").trim();
  if (mode === "call") {
    return typed.length >= 10
      ? readCall(typed)
      : { error: "Type or dictate what the customer asked for." };
  }
  if (mode !== "upload") {
    return typed ? readPasted(typed) : { error: "Paste the RFQ email." };
  }
  const files = await uploadedFiles(orgId, form);
  if (files.length === 0) {
    return { error: "Choose the RFQ's files." };
  }
  const total = files.reduce((sum, f) => sum + f.bytes.length, 0);
  if (total > MAX_UPLOAD_BYTES) {
    return {
      error:
        "Upload up to 20 MB at once. Zip the drawings, or email the package to your RFQ address.",
    };
  }
  const text = await readRfqUpload(files);
  const override = String(form.get("channel") ?? "");
  return (OVERRIDES as readonly string[]).includes(override)
    ? { ...text, source: override as RfqText["source"] }
    : text;
};

export type SubmitResult =
  | { ok: true; id: string }
  | { ok: false; error: string; existing?: { id: string; label: string } };

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

const loadRfq = async (orgId: string, rfqId: string) =>
  forOrg(database, orgId).rfq.findFirst({
    where: { id: rfqId },
    select: { id: true, status: true },
  });

const EDITABLE = ["review", "drafted", "failed"];

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

const WAITING = ["new_sender", "filtered"];

/** Rfq.extracted with its screening note updated (the inbox shows it). */
const withScreen = (extracted: unknown, lane: string, reason: string) => ({
  ...((extracted as object | null) ?? {}),
  screen: {
    ...((extracted as { screen?: object } | null)?.screen ?? {}),
    lane,
    reason,
  },
});

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

const RfqFields = z.object({
  customerName: z.string().trim().max(200),
  contact: z.string().trim().max(300),
  requestedDate: z.union([
    z.literal(""),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ]),
  notes: z.string().trim().max(4000),
});

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

const LineFields = z.object({
  partNo: z.string().trim().max(100),
  rev: z.string().trim().max(20),
  description: z.string().trim().max(500),
  materialText: z.string().trim().max(200),
  qtys: z.string().trim().max(200),
  tolerances: z.string().trim().max(500),
  finish: z.string().trim().max(300),
  notes: z.string().trim().max(1000),
});

type LineFieldValues = z.input<typeof LineFields>;

/** The quantities, or why the line can't be saved. */
const lineQtys = (v: z.output<typeof LineFields>): number[] | string => {
  if (!(v.partNo || v.description)) {
    return "Give the part number or a description.";
  }
  const qtys = parseQtys(v.qtys);
  if (!qtys) {
    return "Quantities: whole numbers, e.g. 50, 100, 250.";
  }
  if (qtys.length > MAX_QTY_BREAKS) {
    return `Up to ${MAX_QTY_BREAKS} quantities per line.`;
  }
  return qtys;
};

interface LineSpec {
  finish: string | null;
  materialId: string | null;
  partId: string | null;
  partNo: string | null;
  qtys: number[];
}

/** What a change to a line's spec throws away: its draft, and inputs tied to the old part or finish. */
const clearedBy = (before: LineSpec, after: LineSpec) => {
  const partChanged =
    before.partId !== after.partId || before.partNo !== after.partNo;
  const finishChanged = before.finish !== after.finish;
  const specChanged =
    partChanged ||
    finishChanged ||
    before.materialId !== after.materialId ||
    before.qtys.join() !== after.qtys.join();
  return {
    ...(partChanged ? { routing: Prisma.DbNull } : {}),
    ...(finishChanged ? { outside: Prisma.DbNull } : {}),
    ...(specChanged ? { draft: Prisma.DbNull, final: Prisma.DbNull } : {}),
  };
};

type LineData = LineSpec & {
  description: string | null;
  materialText: string | null;
  notes: string | null;
  rev: string | null;
  tolerances: string | null;
};

/** Update the line (clearing what the change invalidates), or add it at the end. */
const writeLine = async (
  orgId: string,
  rfqId: string,
  existing: (LineSpec & { id: string }) | null,
  data: LineData
) => {
  const db = forOrg(database, orgId);
  if (existing) {
    const cleared = clearedBy(existing, data);
    await db.rfqLine.updateMany({
      where: { id: existing.id },
      data: { ...data, ...cleared },
    });
  } else {
    const last = await db.rfqLine.findFirst({
      where: { rfqId },
      orderBy: { lineNo: "desc" },
      select: { lineNo: true },
    });
    await db.rfqLine.create({
      data: {
        ...data,
        orgId,
        rfqId,
        lineNo: (last?.lineNo ?? 0) + 1,
      },
    });
  }
};

/** Add a line (lineId null) or change one. A changed part or quantity clears its draft. */
export const saveLine = async (
  rfqId: string,
  lineId: string | null,
  values: LineFieldValues
): Promise<Result> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const parsed = LineFields.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }
  const v = parsed.data;
  const qtys = lineQtys(v);
  if (!Array.isArray(qtys)) {
    return { ok: false, error: qtys };
  }
  const rfq = await loadRfq(access.orgId, rfqId);
  if (!(rfq && EDITABLE.includes(rfq.status))) {
    return {
      ok: false,
      error: "This RFQ has been quoted and can't be changed.",
    };
  }
  const db = forOrg(database, access.orgId);
  const [parts, materials, existing] = await Promise.all([
    db.part.findMany({ select: { id: true, partNo: true, rev: true } }),
    db.material.findMany({ select: { id: true, name: true } }),
    lineId
      ? db.rfqLine.findFirst({ where: { id: lineId, rfqId } })
      : Promise.resolve(null),
  ]);
  if (lineId && !existing) {
    return { ok: false, error: "That line no longer exists." };
  }
  const partId = matchPart(v.partNo, v.rev, parts).part?.id ?? null;
  const materialId = matchMaterial(v.materialText, materials)?.id ?? null;
  const data = {
    partNo: v.partNo || null,
    rev: v.rev || null,
    description: v.description || null,
    materialText: v.materialText || null,
    qtys,
    tolerances: v.tolerances || null,
    finish: v.finish || null,
    notes: v.notes || null,
    partId,
    materialId,
  };
  await writeLine(access.orgId, rfqId, existing, data);
  // A new line, or a line whose draft was cleared, needs drafting again.
  const undrafted = await db.rfqLine.count({
    where: { rfqId, draft: { equals: Prisma.DbNull } },
  });
  if (undrafted > 0) {
    await db.rfq.updateMany({
      where: { id: rfqId, status: "drafted" },
      data: { status: "review" },
    });
  }
  await db.rfq.updateMany({
    where: { id: rfqId, status: "failed" },
    data: { status: "review", error: null },
  });
  refresh(rfqId);
  return { ok: true };
};

export const deleteLine = async (
  rfqId: string,
  lineId: string
): Promise<Result> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const rfq = await loadRfq(access.orgId, rfqId);
  if (!(rfq && EDITABLE.includes(rfq.status))) {
    return {
      ok: false,
      error: "This RFQ has been quoted and can't be changed.",
    };
  }
  await forOrg(database, access.orgId).rfqLine.deleteMany({
    where: { id: lineId, rfqId },
  });
  refresh(rfqId);
  return { ok: true };
};

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

const Operation = z.object({
  seq: z.number().int().positive(),
  work_center: z.string().min(1),
  setup_min: z.number().min(0).max(100_000),
  run_min_per_unit: z.number().min(0).max(100_000),
  alt_work_centers: z.array(z.string()).optional(),
  source: z.enum(["routing", "actuals", "comparable", "estimator"]).optional(),
  note: z.string().nullable().optional(),
});

const Inputs = z.object({
  routing: z.array(Operation).max(30).nullable(),
  outside: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(200),
        cost_per_lot: z.number().min(0).nullable().optional(),
        cost_per_unit: z.number().min(0).nullable().optional(),
      })
    )
    .max(10),
  usagePerPart: z.number().positive().nullable(),
  materialCost: z.number().min(0).nullable(),
  targetMargin: z.number().min(0).max(0.85).nullable(),
});

export type LineInputs = z.input<typeof Inputs>;

/** Save the estimator's inputs for a line and estimate it again. */
export const reestimateLine = async (
  rfqId: string,
  lineId: string,
  inputs: LineInputs,
  today: string
): Promise<Result> => {
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
  const parsed = Inputs.safeParse(inputs);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }
  const rfq = await loadRfq(access.orgId, rfqId);
  if (!(rfq && ["review", "drafted"].includes(rfq.status))) {
    return {
      ok: false,
      error: "This RFQ has been quoted and can't be changed.",
    };
  }
  const v = parsed.data;
  const machines = new Set(
    (
      await forOrg(database, access.orgId).workCenter.findMany({
        select: { name: true },
      })
    ).map((w) => w.name)
  );
  const unknown = v.routing?.find((op) => !machines.has(op.work_center));
  if (unknown) {
    return {
      ok: false,
      error: `${unknown.work_center} isn't one of the shop's machines.`,
    };
  }
  const seqs = v.routing?.map((op) => op.seq) ?? [];
  if (new Set(seqs).size !== seqs.length) {
    return { ok: false, error: "Each operation needs its own number." };
  }
  const updated = await forOrg(database, access.orgId).rfqLine.updateMany({
    where: { id: lineId, rfqId },
    data: {
      routing: v.routing
        ? (v.routing.map((op) => ({
            ...op,
            source: op.source ?? "estimator",
          })) as QuoteOperation[] as object[])
        : Prisma.DbNull,
      outside: v.outside as OutsideProcess[] as object[],
      usagePerPart: v.usagePerPart,
      materialCost: v.materialCost,
      targetMargin: v.targetMargin,
    },
  });
  if (updated.count === 0) {
    return { ok: false, error: "That line no longer exists." };
  }
  const result = await estimateLine(access.orgId, lineId, start);
  if (result.ok) {
    // An existing draft reply follows the new estimate (edited ones are kept).
    const orgId = access.orgId;
    after(async () => {
      const current = await forOrg(database, orgId).rfq.findFirst({
        where: { id: rfqId },
        select: { reply: true },
      });
      if (current?.reply) {
        await writeReplyDraft(orgId, rfqId, "auto", { notify: false });
      }
    });
  }
  refresh(rfqId);
  return result.ok ? { ok: true } : result;
};

const Final = z.object({
  breaks: z
    .array(
      z.object({
        qty: z.number().int().positive(),
        unitPrice: z.number().positive("Every price must be more than $0."),
        leadTimeDays: z
          .number()
          .int()
          .min(0, "Lead times can't be negative.")
          .max(730),
      })
    )
    .min(1),
});

/** The prices and lead times the estimator will send (edits to the draft). */
export const saveFinal = async (
  rfqId: string,
  lineId: string,
  final: LineFinal
): Promise<Result> => {
  const access = await authorize("quotes:write");
  if (!access.ok) {
    return access;
  }
  const parsed = Final.safeParse(final);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }
  const rfq = await loadRfq(access.orgId, rfqId);
  if (!(rfq && ["review", "drafted"].includes(rfq.status))) {
    return {
      ok: false,
      error: "This RFQ has been quoted and can't be changed.",
    };
  }
  const line = await forOrg(database, access.orgId).rfqLine.findFirst({
    where: { id: lineId, rfqId },
    select: { qtys: true },
  });
  const qtys = parsed.data.breaks.map((b) => b.qty).sort((a, b) => a - b);
  if (!line || [...line.qtys].sort((a, b) => a - b).join() !== qtys.join()) {
    return { ok: false, error: "The quantities changed; reload the page." };
  }
  await forOrg(database, access.orgId).rfqLine.updateMany({
    where: { id: lineId, rfqId },
    data: { final: parsed.data as object },
  });
  refresh(rfqId);
  return { ok: true };
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
