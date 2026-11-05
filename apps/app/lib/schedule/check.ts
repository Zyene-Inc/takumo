import "server-only";

import { database, forOrg } from "@repo/database";
import { type CapacityResponse, checkCapacity } from "@repo/engine-client";
import {
  CAPACITY_CHECK,
  CHECK_TIME_LIMIT_S,
  type CheckInput,
  engineProblem,
  loadShop,
} from "./plan";
import { releaseFields } from "./request";

interface CapacityQuestion {
  customer?: string | null;
  dueDate: string;
  materialCost?: number | null;
  orderNo?: string | null;
  partId: string;
  price?: number | null;
  qty: number;
}

export type CapacityAnswer =
  | { ok: true; runId: string; input: CheckInput; result: CapacityResponse }
  | { ok: false; error: string };

const nextOrderNo = async (orgId: string, today: string) => {
  const db = forOrg(database, orgId);
  const prefix = `NEW-${today.replaceAll("-", "").slice(2)}-`;
  const taken = await db.order.findMany({
    where: { orderNo: { startsWith: prefix } },
    select: { orderNo: true },
  });
  const used = new Set(taken.map((o) => o.orderNo));
  let n = 1;
  while (used.has(`${prefix}${n}`)) {
    n += 1;
  }
  return `${prefix}${n}`;
};

/**
 * "Can we take this order?" against the shop as of `today`. Saved as a
 * capacity_check run (it shows under Recent checks); the plan isn't changed.
 * Used by the check page and by Ask Takumo.
 */
export const runCapacityCheck = async (
  orgId: string,
  userId: string | null,
  today: string,
  question: CapacityQuestion
): Promise<CapacityAnswer> => {
  const db = forOrg(database, orgId);
  const part = await db.part.findFirst({
    where: { id: question.partId },
    select: { id: true, partNo: true, _count: { select: { routings: true } } },
  });
  if (!part) {
    return { ok: false, error: "That part no longer exists." };
  }
  if (part._count.routings === 0) {
    return {
      ok: false,
      error: `${part.partNo} has no routing, so Takumo can't tell how long it takes. Add its operations first.`,
    };
  }
  const orderNo = question.orderNo || (await nextOrderNo(orgId, today));
  if (await db.order.findFirst({ where: { orderNo }, select: { id: true } })) {
    return {
      ok: false,
      error: `Order ${orderNo} already exists. Use a different order number.`,
    };
  }
  const materialCost = question.materialCost ?? null;
  const price = question.price ?? null;

  const built = await loadShop(orgId, today, {
    includeParts: [part.id],
    materialCost: materialCost === null ? {} : { [part.id]: materialCost },
    // Its material comes after the orders already promised (F3.2-R2).
    extra: {
      orderNo,
      partId: part.id,
      qty: question.qty,
      dueDate: question.dueDate,
    },
  });
  const material = built.extraRelease;

  let result: CapacityResponse;
  try {
    result = await checkCapacity({
      ...built.request,
      time_limit_s: CHECK_TIME_LIMIT_S,
      new_order: {
        order_no: orderNo,
        part_no: built.partKeys[part.id],
        qty: question.qty,
        due_date: question.dueDate,
        price,
        priority: 0,
        ...releaseFields(material, today),
      },
    });
  } catch (error) {
    return { ok: false, error: engineProblem(error) };
  }

  const input: CheckInput = {
    orderNo,
    partId: part.id,
    partNo: part.partNo,
    qty: question.qty,
    dueDate: question.dueDate,
    customer: question.customer || null,
    price,
    materialCost,
    priority: 0,
    startDate: today,
  };
  const run = await database.scheduleRun.create({
    data: {
      orgId,
      objective: CAPACITY_CHECK,
      input: input as object,
      output: result as object,
      solverStatus: result.status,
      createdBy: userId,
    },
  });
  return { ok: true, runId: run.id, input, result };
};
