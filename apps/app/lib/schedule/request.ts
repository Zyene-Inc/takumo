// Turns shop records into a scheduling-engine request. Pure (no database), so
// it's unit-tested; lib/schedule/plan.ts does the loading and saving.

import type {
  DayException,
  Order,
  Part,
  Pin,
  ScheduleRequest,
  WorkCenter,
} from "@repo/engine-client/types";

/** Hours we assume for a machine whose sheet didn't say. */
export const DEFAULT_HOURS_PER_DAY = 8;

export interface WorkCenterRow {
  calendar: { availableHours: number; date: Date; reason: string | null }[];
  efficiency: number;
  hourlyRate: { toString(): string } | null;
  id: string;
  name: string;
  shifts: unknown;
}

export interface PartRow {
  id: string;
  material: { unit: string; unitCost: { toString(): string } | null } | null;
  partNo: string;
  rev: string;
  routings: {
    altWorkCenterIds: string[];
    runMinPerUnit: number;
    seq: number;
    setupMin: number;
    workCenterId: string;
  }[];
}

export interface OrderRow {
  /** Operations already finished on the floor; only the rest are planned. */
  doneSeqs?: number[];
  dueDate: Date;
  orderNo: string;
  partId: string;
  price: { toString(): string } | null;
  priority: number;
  qty: number;
}

export interface PinRow {
  orderNo: string;
  plannedStart: Date;
  routingSeq: number;
  workCenterId: string;
}

export interface ShopRows {
  orders: OrderRow[];
  parts: PartRow[];
  pins: PinRow[];
  workCenters: WorkCenterRow[];
}

export interface SkippedOrder {
  orderNo: string;
  reason: string;
}

export interface BuiltRequest {
  /** Things Takumo had to assume; shown on the board so someone can fix them. */
  assumptions: string[];
  /** Engine part key for each part id (part numbers, with rev when needed). */
  partKeys: Record<string, string>;
  request: ScheduleRequest;
  skipped: SkippedOrder[];
}

export const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isoDay = (value: Date) => value.toISOString().slice(0, 10);

const toNumber = (value: { toString(): string } | null) =>
  value === null ? null : Number(value.toString());

/** shifts JSON: { hoursPerDay, days? } with days as ISO weekdays (1 = Monday). */
const readShifts = (shifts: unknown) => {
  const value =
    shifts && typeof shifts === "object"
      ? (shifts as { days?: unknown; hoursPerDay?: unknown })
      : {};
  const hours = Number(value.hoursPerDay);
  const days = Array.isArray(value.days)
    ? value.days
        .map(Number)
        .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
        .map((d) => d - 1)
    : null;
  return {
    hoursPerDay:
      Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24) : null,
    workingDays: days && days.length > 0 ? [...new Set(days)].sort() : null,
  };
};

export interface BuildOptions {
  /** Parts to include even with no open order (the part being asked about). */
  includeParts?: string[];
  /** Material cost per finished part, by part id, overriding the material's. */
  materialCost?: Record<string, number>;
}

const toWorkCenter = (
  wc: WorkCenterRow,
  startDate: string,
  assumptions: string[]
): WorkCenter => {
  const { hoursPerDay, workingDays } = readShifts(wc.shifts);
  if (hoursPerDay === null) {
    assumptions.push(
      `${wc.name} has no hours per day; assumed ${DEFAULT_HOURS_PER_DAY} h.`
    );
  }
  const exceptions: DayException[] = wc.calendar
    .filter((day) => isoDay(day.date) >= startDate)
    .map((day) => ({
      date: isoDay(day.date),
      hours: Math.max(0, Math.min(24, day.availableHours)),
      reason: day.reason,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    name: wc.name,
    hours_per_day: hoursPerDay ?? DEFAULT_HOURS_PER_DAY,
    efficiency: Math.min(1.5, Math.max(0.05, wc.efficiency || 1)),
    ...(workingDays ? { working_days: workingDays } : {}),
    ...(exceptions.length ? { exceptions } : {}),
    hourly_rate: toNumber(wc.hourlyRate),
  };
};

/** Part numbers are the engine's keys; add the rev only where two revs share one. */
const toPartKeys = (parts: PartRow[]) => {
  const counts = new Map<string, number>();
  for (const part of parts) {
    counts.set(part.partNo, (counts.get(part.partNo) ?? 0) + 1);
  }
  const keys: Record<string, string> = {};
  for (const part of parts) {
    keys[part.id] =
      (counts.get(part.partNo) ?? 0) > 1
        ? `${part.partNo} rev ${part.rev}`
        : part.partNo;
  }
  return keys;
};

const toPart = (
  part: PartRow,
  key: string,
  wcName: Map<string, string>,
  materialCost: number | undefined
): Part => ({
  part_no: key,
  material_cost:
    materialCost ??
    (part.material?.unit === "ea" ? toNumber(part.material.unitCost) : null),
  routing: [...part.routings]
    .sort((a, b) => a.seq - b.seq)
    .map((r) => ({
      seq: r.seq,
      work_center: wcName.get(r.workCenterId) ?? r.workCenterId,
      setup_min: Math.max(0, r.setupMin),
      run_min_per_unit: Math.max(0, r.runMinPerUnit),
      alt_work_centers: r.altWorkCenterIds
        .map((id) => wcName.get(id))
        .filter((n): n is string => Boolean(n)),
    })),
});

/** Pins only for operations still in the plan, today or later, on a machine
 * the routing allows. */
const toPins = (
  rows: PinRow[],
  orders: Order[],
  parts: Part[],
  wcName: Map<string, string>,
  startDate: string
): Pin[] => {
  const planned = new Map(orders.map((o) => [o.order_no, o]));
  const partByKey = new Map(parts.map((p) => [p.part_no, p]));
  return rows.flatMap((pin) => {
    const order = planned.get(pin.orderNo);
    const op = partByKey
      .get(order?.part_no ?? "")
      ?.routing.find((r) => r.seq === pin.routingSeq);
    const machine = wcName.get(pin.workCenterId);
    const day = isoDay(pin.plannedStart);
    const allowed =
      op && machine
        ? [op.work_center, ...(op.alt_work_centers ?? [])].includes(machine)
        : false;
    return allowed && machine && day >= startDate
      ? [
          {
            order_no: pin.orderNo,
            seq: pin.routingSeq,
            work_center: machine,
            start_date: day,
          },
        ]
      : [];
  });
};

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

  const orders: Order[] = [];
  for (const order of [...rows.orders].sort((a, b) =>
    a.orderNo.localeCompare(b.orderNo)
  )) {
    const part = partsById.get(order.partId);
    if (!part || part.routings.length === 0) {
      skipped.push({
        orderNo: order.orderNo,
        reason: `${part?.partNo ?? "Its part"} has no routing`,
      });
      continue;
    }
    const done = new Set(order.doneSeqs ?? []);
    const remaining = part.routings.filter((r) => !done.has(r.seq));
    if (remaining.length === 0) {
      skipped.push({
        orderNo: order.orderNo,
        reason: "every operation is finished; mark the order done",
      });
      continue;
    }
    let partNo = partKeys[part.id];
    if (remaining.length < part.routings.length) {
      // The rest of the routing, as its own part for the engine.
      const last = Math.max(...done);
      partNo = `${partKeys[part.id]} after op ${last}`;
      if (!usedParts.has(partNo)) {
        usedParts.set(
          partNo,
          toPart(
            { ...part, routings: remaining },
            partNo,
            wcName,
            options.materialCost?.[part.id]
          )
        );
      }
    } else {
      addPart(part);
    }
    orders.push({
      order_no: order.orderNo,
      part_no: partNo,
      qty: order.qty,
      due_date: isoDay(order.dueDate),
      priority: Math.max(0, Math.min(10, order.priority)),
      price: toNumber(order.price),
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
    },
  };
};

/** Stable JSON (sorted keys): Postgres jsonb doesn't keep key order. */
export const canonicalJson = (value: unknown): string =>
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
