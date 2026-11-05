import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseQtys } from "@/lib/quotes/numbers";
import {
  type RfqText,
  readCall,
  readPasted,
  readRfqUpload,
} from "@/lib/quotes/read";
import { MAX_QTY_BREAKS } from "@/lib/quotes/types";
import { isUploadId, MAX_UPLOAD_BYTES } from "@/lib/quotes/upload-limits";
import { takeUpload } from "@/lib/quotes/upload-parts";

export type Result<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

export const WRONG_DATE =
  "Your computer's date looks wrong; reload and try again.";

export const refresh = (rfqId?: string) => {
  revalidatePath("/quotes");
  if (rfqId) {
    revalidatePath(`/quotes/${rfqId}`);
  }
};

export const firstIssue = (error: z.ZodError) =>
  error.issues[0]?.message ?? "Check the form.";

/** Everything uploaded at once (the server action's body limit). */
export const OVERRIDES = ["portal", "form"] as const;

export const uploadedFiles = (orgId: string, form: FormData) => {
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

/** The RFQ's text and files from the form: an upload, a paste or a call. */
export const rfqFromForm = async (
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

export const loadRfq = async (orgId: string, rfqId: string) =>
  forOrg(database, orgId).rfq.findFirst({
    where: { id: rfqId },
    select: { id: true, status: true },
  });

export const EDITABLE = ["review", "drafted", "failed"];

export const WAITING = ["new_sender", "filtered"];

/** Rfq.extracted with its screening note updated (the inbox shows it). */
export const withScreen = (
  extracted: unknown,
  lane: string,
  reason: string
) => ({
  ...((extracted as object | null) ?? {}),
  screen: {
    ...((extracted as { screen?: object } | null)?.screen ?? {}),
    lane,
    reason,
  },
});

export const RfqFields = z.object({
  customerName: z.string().trim().max(200),
  contact: z.string().trim().max(300),
  requestedDate: z.union([
    z.literal(""),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ]),
  notes: z.string().trim().max(4000),
});

export const LineFields = z.object({
  partNo: z.string().trim().max(100),
  rev: z.string().trim().max(20),
  description: z.string().trim().max(500),
  materialText: z.string().trim().max(200),
  qtys: z.string().trim().max(200),
  tolerances: z.string().trim().max(500),
  finish: z.string().trim().max(300),
  notes: z.string().trim().max(1000),
});

export type LineFieldValues = z.input<typeof LineFields>;

/** The quantities, or why the line can't be saved. */
export const lineQtys = (v: z.output<typeof LineFields>): number[] | string => {
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

export interface LineSpec {
  finish: string | null;
  materialId: string | null;
  partId: string | null;
  partNo: string | null;
  qtys: number[];
}

/** What a change to a line's spec throws away: its draft, and inputs tied to the old part or finish. */
export const clearedBy = (before: LineSpec, after: LineSpec) => {
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

export type LineData = LineSpec & {
  description: string | null;
  materialText: string | null;
  notes: string | null;
  rev: string | null;
  tolerances: string | null;
};

/** Update the line (clearing what the change invalidates), or add it at the end. */
export const writeLine = async (
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

export const Operation = z.object({
  seq: z.number().int().positive(),
  work_center: z.string().min(1),
  setup_min: z.number().min(0).max(100_000),
  run_min_per_unit: z.number().min(0).max(100_000),
  alt_work_centers: z.array(z.string()).optional(),
  source: z.enum(["routing", "actuals", "comparable", "estimator"]).optional(),
  note: z.string().nullable().optional(),
});

export const Inputs = z.object({
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

export const Final = z.object({
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
