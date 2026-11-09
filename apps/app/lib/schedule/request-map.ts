import type {
  DayException,
  Operator,
  Order,
  Part,
  Pin,
  WorkCenter,
} from "@repo/engine-client/types";
import { readShift } from "@repo/ingest";
import type {
  OperatorRow,
  OrderRow,
  PartRow,
  PinRow,
  ReleaseRow,
  WorkCenterRow,
} from "./request-rows";
import { isoDay } from "./request-rows";

/** Hours we assume for a machine whose sheet didn't say. */
export const DEFAULT_HOURS_PER_DAY = 8;

export const toNumber = (value: { toString(): string } | null) =>
  value === null ? null : Number(value.toString());

/** shifts JSON: { hoursPerDay, days? } with days as ISO weekdays (1 = Monday). */
export const readShifts = (shifts: unknown) => {
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

export const toWorkCenter = (
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
    operators_per_machine: Math.min(
      4,
      Math.max(0.05, wc.operatorsPerMachine ?? 1)
    ),
    unattended_runs: wc.unattendedRuns ?? false,
  };
};

/**
 * The active roster for the engine: machines by name (unknown ids dropped),
 * shifts with Monday = 0, time off from the plan start on.
 */
export const toOperators = (
  rows: OperatorRow[],
  wcName: Map<string, string>,
  startDate: string
): Operator[] =>
  rows
    .filter((o) => o.active)
    .map((o) => {
      const shift = readShift(o.shifts);
      const timeOff = o.days
        .filter((d) => isoDay(d.date) >= startDate)
        .map((d) => ({
          date: isoDay(d.date),
          hours: Math.max(0, Math.min(24, d.hours)),
          reason: d.reason,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
      return {
        id: o.id,
        name: o.name,
        work_centers: o.workCenterIds
          .map((id) => wcName.get(id))
          .filter((n): n is string => Boolean(n)),
        ...(shift
          ? {
              shifts: [
                {
                  start: shift.start,
                  end: shift.end,
                  days: shift.days.map((d) => d - 1),
                },
              ],
            }
          : {}),
        unattended: o.canRunUnattended,
        ...(timeOff.length ? { time_off: timeOff } : {}),
      };
    })
    .filter((o) => o.work_centers.length > 0);

/** Part numbers are the engine's keys; add the rev only where two revs share one. */
export const toPartKeys = (parts: PartRow[]) => {
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

export const toPart = (
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
export const toPins = (
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

/** Why an order can't be planned, or null when it can. */
export const skipReason = (
  qty: number,
  part: { partNo: string; routings: unknown[] } | undefined,
  remaining: unknown[]
) => {
  if (qty <= 0) {
    return "its quantity is 0";
  }
  if (!part || part.routings.length === 0) {
    return `${part?.partNo ?? "Its part"} has no routing`;
  }
  return remaining.length === 0
    ? "every operation is finished; mark the order done"
    : null;
};

/**
 * The engine's name for what's left of a part's routing. Named by the steps
 * left, so orders with different steps done never share one.
 */
export const remainingKey = (
  key: string,
  done: Set<number>,
  remaining: { seq: number }[],
  through: [number, number][] = []
) => {
  const partly = through.length
    ? ` (${through.map(([seq, n]) => `op ${seq}: ${n} through`).join(", ")})`
    : "";
  if (done.size === 0) {
    return `${key}${partly}`;
  }
  const last = Math.max(...done);
  return remaining.every((r) => r.seq > last)
    ? `${key} after op ${last}${partly}`
    : `${key} ops ${remaining.map((r) => r.seq).join(", ")}${partly}`;
};

/**
 * Steps with parts already through: setup is done and only the parts left
 * run. A step with every part through counts as done.
 */
export const applyProgress = <
  R extends { runMinPerUnit: number; seq: number; setupMin: number },
>(
  qty: number,
  routings: R[],
  progress: Record<number, number> = {}
) => {
  const finished = new Set<number>();
  const through: [number, number][] = [];
  const left = routings.flatMap((r) => {
    const n = progress[r.seq] ?? 0;
    if (n <= 0) {
      return [r];
    }
    if (n >= qty) {
      finished.add(r.seq);
      return [];
    }
    through.push([r.seq, n]);
    return [
      { ...r, setupMin: 0, runMinPerUnit: (r.runMinPerUnit * (qty - n)) / qty },
    ];
  });
  return { left, finished, through };
};

/** An order's material date (only when later than the start) and note. */
export const releaseFields = (
  release: ReleaseRow | null | undefined,
  startDate: string
): Pick<Order, "release_date" | "release_note"> => ({
  ...(release?.date && release.date > startDate
    ? { release_date: release.date }
    : {}),
  ...(release ? { release_note: release.note } : {}),
});

/** An order's routing steps still to run: finished steps and parts through left out. */
export const remainingWork = (order: OrderRow, part: PartRow | undefined) => {
  const done = new Set(order.doneSeqs ?? []);
  const progressed = applyProgress(
    order.qty,
    (part?.routings ?? []).filter((r) => !done.has(r.seq)),
    order.progress
  );
  for (const seq of progressed.finished) {
    done.add(seq);
  }
  return { done, remaining: progressed.left, through: progressed.through };
};

export type RemainingWork = ReturnType<typeof remainingWork>;
