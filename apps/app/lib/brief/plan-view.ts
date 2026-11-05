// What the morning brief says about the plan (docs/PRODUCT-PLAN.md F4.1-R2):
// orders projected late or at risk, with the cause and the best lever; the
// day's bottleneck machine; orders starting this week whose material isn't
// here. Read from the latest saved plan, so the brief costs no scheduling.
// Pure, so tested.

import type {
  ScheduleRequest,
  ScheduleResponse,
} from "@repo/engine-client/types";
import type { MaterialReady } from "../schedule/material";
import { shortDay } from "../schedule/material";

const DAY_MS = 86_400_000;

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

export type LateCause = "material" | "people" | "machine";

export interface LateOrder {
  cause: LateCause;
  /** In words: "HAAS-VF2 is fully booked". */
  causeText: string;
  completion: string;
  customer: string | null;
  daysLate: number;
  due: string;
  /** In words: "Overtime on HAAS-VF2". */
  lever: string;
  orderNo: string;
}

interface Plan {
  output: ScheduleResponse;
  request: ScheduleRequest;
}

/** The operation an order finishes with, and the one it starts with. */
const endsOf = (output: ScheduleResponse, orderNo: string) => {
  const ops = output.operations
    .filter((o) => o.order_no === orderNo)
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
  return { first: ops[0], last: ops.at(-1) };
};

/** Why an order is late, and what would help most. */
const causeOf = (
  plan: Plan,
  orderNo: string,
  completion: string
): Pick<LateOrder, "cause" | "causeText" | "lever"> => {
  const order = plan.request.orders.find((o) => o.order_no === orderNo);
  const { first, last } = endsOf(plan.output, orderNo);
  const release = order?.release_date;
  if (
    release &&
    release > plan.request.start_date &&
    first &&
    first.start_date <= release
  ) {
    return {
      cause: "material",
      causeText: order?.release_note
        ? `Waiting for material (${order.release_note})`
        : `Waiting for material until ${shortDay(release)}`,
      lever: "Expedite the material, or use stock from another order",
    };
  }
  const machine = last?.work_center ?? null;
  if (!machine) {
    return {
      cause: "machine",
      causeText: "Not enough machine time before the due date",
      lever: "Add overtime, or talk to the customer about the date",
    };
  }
  const shortOfPeople = plan.output.load.some(
    (d) =>
      d.work_center === machine &&
      d.date <= completion &&
      d.machine_minutes !== null &&
      d.machine_minutes !== undefined &&
      d.machine_minutes > d.capacity_minutes
  );
  if (shortOfPeople) {
    return {
      cause: "people",
      causeText: `Not enough people on ${machine}`,
      lever: `Put another qualified person on ${machine}, or add overtime`,
    };
  }
  const part = plan.request.parts.find((p) => p.part_no === order?.part_no);
  const alt = part?.routing
    .find((r) => r.seq === last?.seq)
    ?.alt_work_centers?.find((w) => w !== machine);
  return {
    cause: "machine",
    causeText: `${machine} is fully booked`,
    lever: alt
      ? `Move op ${last?.seq} to ${alt}`
      : `Overtime on ${machine}, or split the lot`,
  };
};

/**
 * Orders projected late, and at risk (finishing on, or the day before, the
 * due date). Late first, the latest first.
 */
export const lateOrders = (
  plan: Plan,
  customers: Map<string, string | null>
): { late: LateOrder[]; atRisk: LateOrder[] } => {
  const late: LateOrder[] = [];
  const atRisk: LateOrder[] = [];
  for (const o of plan.output.orders) {
    const risky =
      o.days_late <= 0 && o.completion_date >= addDays(o.due_date, -1);
    if (!(o.days_late > 0 || risky)) {
      continue;
    }
    const row: LateOrder = {
      orderNo: o.order_no,
      customer: customers.get(o.order_no) ?? null,
      daysLate: Math.max(0, o.days_late),
      due: o.due_date,
      completion: o.completion_date,
      ...causeOf(plan, o.order_no, o.completion_date),
    };
    (o.days_late > 0 ? late : atRisk).push(row);
  }
  late.sort((a, b) => b.daysLate - a.daysLate || a.due.localeCompare(b.due));
  atRisk.sort((a, b) => a.due.localeCompare(b.due));
  return { late, atRisk };
};

export interface Bottleneck {
  capacityMinutes: number;
  date: string;
  loadMinutes: number;
  machine: string;
}

/** The busiest machine on `today` (as a share of its hours), if any runs. */
export const bottleneckOn = (
  output: ScheduleResponse,
  today: string
): Bottleneck | null => {
  const day = output.load.filter(
    (d) => d.date === today && d.capacity_minutes > 0 && d.load_minutes > 0
  );
  const top = day.sort(
    (a, b) =>
      b.load_minutes / b.capacity_minutes - a.load_minutes / a.capacity_minutes
  )[0];
  return top
    ? {
        machine: top.work_center,
        date: top.date,
        loadMinutes: top.load_minutes,
        capacityMinutes: top.capacity_minutes,
      }
    : null;
};

export interface MaterialShort {
  /** Where the material comes from, in words. */
  note: string;
  notOrdered: boolean;
  orderNo: string;
  /** When the material is ready (null: nobody has ordered it). */
  ready: string | null;
  /** The order's first operation in the plan. */
  starts: string;
}

/**
 * Orders the plan starts within the next 7 days whose material isn't here
 * today: on a PO that arrives later, or not ordered at all.
 */
export const materialShortThisWeek = (
  output: ScheduleResponse,
  material: Map<string, MaterialReady>,
  today: string
): MaterialShort[] => {
  const weekEnd = addDays(today, 7);
  const starts = new Map<string, string>();
  for (const op of output.operations) {
    const seen = starts.get(op.order_no);
    if (!seen || op.start_date < seen) {
      starts.set(op.order_no, op.start_date);
    }
  }
  const rows: MaterialShort[] = [];
  for (const [orderNo, start] of starts) {
    const m = material.get(orderNo);
    if (!m || m.unknown || start >= weekEnd) {
      continue;
    }
    if (m.notOrdered || (m.date !== null && m.date > today)) {
      rows.push({
        orderNo,
        starts: start < today ? today : start,
        ready: m.notOrdered ? null : m.date,
        note: m.note,
        notOrdered: m.notOrdered,
      });
    }
  }
  return rows.sort(
    (a, b) =>
      a.starts.localeCompare(b.starts) || a.orderNo.localeCompare(b.orderNo)
  );
};
