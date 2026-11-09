// Turns shop records into a scheduling-engine request. Pure (no database), so
// it's unit-tested; lib/schedule/plan.ts does the loading and saving.

import type { Order, Part, ScheduleRequest } from "@repo/engine-client/types";

import {
  type RemainingWork,
  releaseFields,
  remainingKey,
  remainingWork,
  skipReason,
  toNumber,
  toOperators,
  toPart,
  toPartKeys,
  toPins,
  toWorkCenter,
} from "./request-map";
import {
  type BuildOptions,
  type BuiltRequest,
  ISO_DAY,
  isoDay,
  type PartRow,
  type ShopRows,
  type SkippedOrder,
} from "./request-rows";

export { DEFAULT_HOURS_PER_DAY, releaseFields } from "./request-map";
export type {
  BuildOptions,
  BuiltRequest,
  OperatorRow,
  OrderRow,
  PartRow,
  PinRow,
  ReleaseRow,
  ShopRows,
  SkippedOrder,
  WorkCenterRow,
} from "./request-rows";
export { ISO_DAY, isoDay } from "./request-rows";

export const buildScheduleRequest = (
  rows: ShopRows,
  startDate: string,
  options: BuildOptions = {}
): BuiltRequest => {
  const assumptions: string[] = [];
  const skipped: SkippedOrder[] = [];
  const wcName = new Map(rows.workCenters.map((wc) => [wc.id, wc.name]));
  const workCenters = rows.workCenters.map((wc) =>
    toWorkCenter(wc, startDate, assumptions)
  );
  const partKeys = toPartKeys(rows.parts);
  const partsById = new Map(rows.parts.map((p) => [p.id, p]));
  const usedParts = new Map<string, Part>();
  const addPart = (part: PartRow) => {
    if (!usedParts.has(part.id)) {
      usedParts.set(
        part.id,
        toPart(part, partKeys[part.id], wcName, options.materialCost?.[part.id])
      );
    }
  };

  // The rest of an order's routing is its own part for the engine, unless
  // it's the whole routing.
  const partNoFor = (part: PartRow, work: RemainingWork) => {
    if (
      work.remaining.length >= part.routings.length &&
      work.through.length === 0
    ) {
      addPart(part);
      return partKeys[part.id];
    }
    const partNo = remainingKey(
      partKeys[part.id],
      work.done,
      work.remaining,
      work.through
    );
    if (!usedParts.has(partNo)) {
      usedParts.set(
        partNo,
        toPart(
          { ...part, routings: work.remaining },
          partNo,
          wcName,
          options.materialCost?.[part.id]
        )
      );
    }
    return partNo;
  };

  const orders: Order[] = [];
  for (const order of [...rows.orders].sort((a, b) =>
    a.orderNo.localeCompare(b.orderNo)
  )) {
    const part = partsById.get(order.partId);
    const work = remainingWork(order, part);
    const reason = skipReason(order.qty, part, work.remaining);
    if (reason || !part) {
      skipped.push({ orderNo: order.orderNo, reason: reason ?? "" });
      continue;
    }
    orders.push({
      order_no: order.orderNo,
      part_no: partNoFor(part, work),
      qty: order.qty,
      due_date: isoDay(order.dueDate),
      priority: Math.max(0, Math.min(10, order.priority)),
      price: toNumber(order.price),
      ...releaseFields(rows.release?.get(order.orderNo), startDate),
    });
  }
  for (const id of options.includeParts ?? []) {
    const part = partsById.get(id);
    if (part && part.routings.length > 0) {
      addPart(part);
    }
  }
  const parts = [...usedParts.values()];

  return {
    assumptions,
    partKeys,
    skipped,
    request: {
      start_date: startDate,
      work_centers: workCenters,
      parts,
      orders,
      pins: toPins(rows.pins, orders, parts, wcName, startDate),
      ...(rows.operators?.length
        ? { operators: toOperators(rows.operators, wcName, startDate) }
        : {}),
    },
  };
};

/** Stable JSON (sorted keys): Postgres jsonb doesn't keep key order. */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b)
          )
        )
      : v
  );

/** What a plan depends on, minus the day it was made. */
export const planFingerprint = (request: ScheduleRequest) => {
  const { start_date: _start, time_limit_s: _limit, ...rest } = request;
  return canonicalJson(rest);
};

/** YYYY-MM-DD from the browser, checked against the server's clock. */
export const checkToday = (today: string, now = new Date()) => {
  if (!ISO_DAY.test(today)) {
    return null;
  }
  const diff = Math.abs(Date.parse(`${today}T00:00:00Z`) - now.getTime());
  return diff <= 2 * 86_400_000 ? today : null;
};
