"use server";

import { database, forOrg, Prisma } from "@repo/database";
import { revalidatePath } from "next/cache";
import { authorize } from "@/lib/access";
import { featureProblem } from "@/lib/billing";
import { type LineFields, mergeLines, splitLine } from "@/lib/quotes/lines";

// The estimator merges two lines that are the same part, or splits one that
// is really two (docs/PRODUCT-PLAN.md F2.2-R8).

type Result = { ok: true } | { ok: false; error: string };

const EDITABLE = ["review", "drafted", "failed"];

const FIELDS = {
  id: true,
  lineNo: true,
  partNo: true,
  rev: true,
  description: true,
  materialText: true,
  finish: true,
  tolerances: true,
  notes: true,
  partId: true,
  materialId: true,
  fileId: true,
  drawing: true,
  qtys: true,
  quoteId: true,
} as const;

const asData = (f: LineFields) => ({
  partNo: f.partNo,
  rev: f.rev,
  description: f.description,
  materialText: f.materialText,
  finish: f.finish,
  tolerances: f.tolerances,
  notes: f.notes,
  partId: f.partId,
  materialId: f.materialId,
  fileId: f.fileId,
  qtys: f.qtys,
  drawing: f.drawing === null ? Prisma.DbNull : (f.drawing as object),
});

const access = async (rfqId: string) => {
  const a = await authorize("quotes:write");
  if (!a.ok) {
    return a;
  }
  const locked = await featureProblem(a.orgId, "quotes");
  if (locked) {
    return { ok: false as const, error: locked };
  }
  const rfq = await forOrg(database, a.orgId).rfq.findFirst({
    where: { id: rfqId },
    select: { status: true },
  });
  if (!(rfq && EDITABLE.includes(rfq.status))) {
    return {
      ok: false as const,
      error: "This RFQ has been quoted and can't be changed.",
    };
  }
  return a;
};

/** Number the lines 1, 2, 3… again (two passes: lineNo is unique per RFQ). */
const renumber = async (orgId: string, rfqId: string) => {
  const db = forOrg(database, orgId);
  const lines = await db.rfqLine.findMany({
    where: { rfqId },
    orderBy: { lineNo: "asc" },
    select: { id: true, lineNo: true },
  });
  if (lines.every((l, i) => l.lineNo === i + 1)) {
    return;
  }
  await database.$transaction([
    ...lines.map((l, i) =>
      database.rfqLine.updateMany({
        where: { id: l.id, orgId },
        data: { lineNo: 10_000 + i },
      })
    ),
    ...lines.map((l, i) =>
      database.rfqLine.updateMany({
        where: { id: l.id, orgId },
        data: { lineNo: i + 1 },
      })
    ),
  ]);
};

/** Fold `dropId` into `keepId`: the kept line's values win. */
export const mergeRfqLines = async (
  rfqId: string,
  keepId: string,
  dropId: string
): Promise<Result> => {
  const a = await access(rfqId);
  if (!a.ok) {
    return a;
  }
  if (keepId === dropId) {
    return { ok: false, error: "Choose another line to merge with." };
  }
  const db = forOrg(database, a.orgId);
  const [keep, drop] = await Promise.all([
    db.rfqLine.findFirst({ where: { id: keepId, rfqId }, select: FIELDS }),
    db.rfqLine.findFirst({ where: { id: dropId, rfqId }, select: FIELDS }),
  ]);
  if (!(keep && drop)) {
    return { ok: false, error: "That line no longer exists." };
  }
  if (keep.quoteId || drop.quoteId) {
    return { ok: false, error: "A quoted line can't be merged." };
  }
  const { merged, requantified } = mergeLines(keep, drop);
  await database.$transaction([
    database.rfqLine.deleteMany({ where: { id: drop.id, orgId: a.orgId } }),
    database.rfqLine.updateMany({
      where: { id: keep.id, orgId: a.orgId },
      data: {
        ...asData(merged),
        // New quantities need a new estimate.
        ...(requantified ? { draft: Prisma.DbNull, final: Prisma.DbNull } : {}),
      },
    }),
  ]);
  await renumber(a.orgId, rfqId);
  revalidatePath(`/quotes/${rfqId}`);
  return { ok: true };
};

/** Copy a line into a new one, to be made into the second part. */
export const splitRfqLine = async (
  rfqId: string,
  lineId: string
): Promise<Result> => {
  const a = await access(rfqId);
  if (!a.ok) {
    return a;
  }
  const db = forOrg(database, a.orgId);
  const line = await db.rfqLine.findFirst({
    where: { id: lineId, rfqId },
    select: FIELDS,
  });
  if (!line) {
    return { ok: false, error: "That line no longer exists." };
  }
  const last = await db.rfqLine.findFirst({
    where: { rfqId },
    orderBy: { lineNo: "desc" },
    select: { lineNo: true },
  });
  try {
    await db.rfqLine.create({
      data: {
        orgId: a.orgId,
        rfqId,
        lineNo: (last?.lineNo ?? 0) + 1,
        ...asData(splitLine(line, line.lineNo)),
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return {
        ok: false,
        error: "Someone else just changed the lines. Try again.",
      };
    }
    throw error;
  }
  revalidatePath(`/quotes/${rfqId}`);
  return { ok: true };
};
