// Approving or rejecting a proposed fact; approval writes the value and keeps the history.

import "server-only";

import { database, forOrg, Prisma } from "@repo/database";
import { trustedViewer, type Viewer } from "../library/viewer";
import {
  attributeDef,
  changesModel,
  type FactValue,
  factLabel,
  parseValue,
} from "./attributes";
import { currentValue, type Result } from "./subjects";
import {
  companyVisible,
  markPublished,
  NO_FACT,
  publishProblem,
  visibleFact,
} from "./visibility";

/**
 * A restricted fact that would change a company record: approving it would
 * show its value to everyone, so it has to be published at the same time.
 */
export const NEEDS_PUBLISHING =
  "This fact comes from documents not everyone may open. Approving it changes a record everyone sees, so it must be published to the company at the same time.";

export type Tx = Prisma.TransactionClient;

export const MISSING_RECORD = "The record this fact is about no longer exists.";

/** Stop the approval when the record wasn't there to update. */
export const expectOne = ({ count }: { count: number }) => {
  if (count === 0) {
    throw new Error(MISSING_RECORD);
  }
};

/** Write an approved value to the record it's about. */
export const applyValue = async (
  tx: Tx,
  orgId: string,
  fact: { subjectType: string; subjectId: string; attribute: string },
  value: FactValue
) => {
  const { subjectType: type, subjectId: id, attribute } = fact;
  const where = { id, orgId };
  if (type === "routing") {
    if (attribute === "workCenter") {
      const machine = await tx.workCenter.findFirst({
        where: { orgId, name: String(value) },
        select: { id: true },
      });
      if (!machine) {
        throw new Error(`No machine "${value}".`);
      }
      expectOne(
        await tx.routing.updateMany({
          where,
          data: {
            workCenterId: machine.id,
            provenance: "stated",
            confidence: 1,
          },
        })
      );
      return;
    }
    expectOne(
      await tx.routing.updateMany({
        where,
        data: {
          [attribute]: Number(value),
          provenance: "stated",
          confidence: 1,
        },
      })
    );
    return;
  }
  if (type === "work_center") {
    if (attribute === "hoursPerDay") {
      const wc = await tx.workCenter.findFirst({
        where,
        select: { shifts: true },
      });
      const shifts = (wc?.shifts as Record<string, unknown> | null) ?? {};
      expectOne(
        await tx.workCenter.updateMany({
          where,
          data: {
            shifts: { ...shifts, hoursPerDay: Number(value) },
            provenance: "stated",
          },
        })
      );
      return;
    }
    expectOne(
      await tx.workCenter.updateMany({
        where,
        data: { [attribute]: Number(value), provenance: "stated" },
      })
    );
    return;
  }
  if (type === "material") {
    expectOne(
      await tx.material.updateMany({
        where,
        data: { [attribute]: Number(value), provenance: "stated" },
      })
    );
    return;
  }
  if (type === "customer" && attribute === "paymentTermDays") {
    expectOne(
      await tx.customer.updateMany({
        where,
        data: { paymentTermDays: Number(value) },
      })
    );
  }
};

/**
 * Approve a pending fact the reviewer may see (optionally with a corrected
 * value). A model parameter is written to its record, which everyone sees:
 * the fact becomes company knowledge (published). A restricted fact can
 * only do that with `publish` from someone who may publish it; a restricted
 * note stays restricted when approved. The fact it replaces is kept as
 * superseded, so the history stays.
 */
export const approveFact = async (
  viewer: Viewer,
  factId: string,
  options: { value?: unknown; note?: string | null; publish?: boolean } = {}
): Promise<Result<{ label: string }>> => {
  const { orgId, userId } = trustedViewer(viewer);
  if (!userId) {
    return { ok: false, error: "Only a person can review facts." };
  }
  const reviewer = userId;
  const fact = await visibleFact(viewer, factId);
  if (!fact) {
    return { ok: false, error: NO_FACT };
  }
  if (fact.status !== "pending") {
    return {
      ok: false,
      error: `${factLabel(fact.number)} is already ${fact.status}.`,
    };
  }
  const def = attributeDef(fact.subjectType, fact.attribute);
  if (!def) {
    return { ok: false, error: "This fact's attribute isn't supported." };
  }
  let value = fact.value as FactValue;
  if (options.value !== undefined) {
    const parsed = parseValue(def, options.value);
    if (!parsed.ok) {
      return parsed;
    }
    value = parsed.value;
  }
  // Writing the value into a record shows it to everyone.
  const publishes =
    changesModel(fact.attribute) &&
    !fact.publishedAt &&
    !(await companyVisible(orgId, fact.id));
  if (publishes) {
    if (!options.publish) {
      return { ok: false, error: NEEDS_PUBLISHING };
    }
    const problem = await publishProblem(viewer, fact);
    if (problem) {
      return { ok: false, error: problem };
    }
  }
  const previous = await currentValue(
    orgId,
    fact.subjectType,
    fact.subjectId,
    fact.attribute
  );
  const now = new Date();
  try {
    await database.$transaction(async (tx) => {
      // Claim it first: two reviewers can't both approve (or approve and reject).
      const claimed = await tx.fact.updateMany({
        where: { id: fact.id, orgId, status: "pending" },
        data: { status: "approved" },
      });
      if (claimed.count === 0) {
        throw new Error(`${factLabel(fact.number)} has already been reviewed.`);
      }
      const replaced = await tx.fact.findMany({
        where: {
          orgId,
          status: "approved",
          subjectType: fact.subjectType,
          subjectId: fact.subjectId,
          attribute: fact.attribute,
          validTo: null,
        },
        orderBy: { validFrom: "desc" },
        select: { id: true },
      });
      // A note adds to what's known; a parameter replaces the old value.
      if (changesModel(fact.attribute)) {
        await applyValue(tx, orgId, fact, value);
        if (replaced.length) {
          await tx.fact.updateMany({
            where: { id: { in: replaced.map((r) => r.id) } },
            data: { status: "superseded", validTo: now },
          });
        }
      }
      await tx.fact.update({
        where: { id: fact.id },
        data: {
          status: "approved",
          value,
          previousValue: previous ?? Prisma.DbNull,
          supersedesFactId: changesModel(fact.attribute)
            ? (replaced[0]?.id ?? null)
            : null,
          reviewedBy: reviewer,
          reviewedAt: now,
          reviewNote: options.note?.trim() || null,
          validFrom: now,
          // In a record everyone sees: company knowledge from now on, whatever
          // happens to the documents it came from (their quotes stay hidden
          // from those who can't open them).
          ...(changesModel(fact.attribute) && !fact.publishedAt
            ? { publishedAt: now, publishedBy: reviewer }
            : {}),
        },
      });
      if (publishes) {
        await markPublished(tx, viewer, fact, "approve_and_publish");
      }
    });
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Couldn't apply the fact.",
    };
  }
  return { ok: true, label: factLabel(fact.number) };
};

/** Reject a pending fact the reviewer may see. */
export const rejectFact = async (
  viewer: Viewer,
  factId: string,
  note: string | null
): Promise<Result<{ label: string }>> => {
  const { orgId, userId } = trustedViewer(viewer);
  if (!userId) {
    return { ok: false, error: "Only a person can review facts." };
  }
  const reviewer = userId;
  const db = forOrg(database, orgId);
  const fact = await visibleFact(viewer, factId);
  if (!fact) {
    return { ok: false, error: NO_FACT };
  }
  if (fact.status !== "pending") {
    return {
      ok: false,
      error: `${factLabel(fact.number)} is already ${fact.status}.`,
    };
  }
  const rejected = await db.fact.updateMany({
    where: { id: fact.id, status: "pending" },
    data: {
      status: "rejected",
      reviewedBy: reviewer,
      reviewedAt: new Date(),
      reviewNote: note?.trim() || null,
    },
  });
  if (rejected.count === 0) {
    return {
      ok: false,
      error: `${factLabel(fact.number)} has already been reviewed.`,
    };
  }
  return { ok: true, label: factLabel(fact.number) };
};
