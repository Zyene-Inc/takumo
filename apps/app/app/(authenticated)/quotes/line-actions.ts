"use server";

import { database, forOrg, Prisma } from "@repo/database";
import type { OutsideProcess, QuoteOperation } from "@repo/engine-client/types";
import { after } from "next/server";
import { authorize } from "@/lib/access";
import { featureProblem } from "@/lib/billing";
import { estimateLine } from "@/lib/quotes/estimate";
import { writeReplyDraft } from "@/lib/quotes/mailbox-reply";
import { matchMaterial, matchPart } from "@/lib/quotes/match";
import type { LineFinal } from "@/lib/quotes/types";
import { checkToday } from "@/lib/schedule/request";
import {
  EDITABLE,
  Final,
  firstIssue,
  Inputs,
  LineFields,
  type LineFieldValues,
  type LineInputs,
  lineQtys,
  loadRfq,
  type Result,
  refresh,
  WRONG_DATE,
  writeLine,
} from "./action-helpers";

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
