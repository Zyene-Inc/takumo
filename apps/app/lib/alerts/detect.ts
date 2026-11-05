// Alerts (docs/PRODUCT-PLAN.md F4.3): what's worth telling someone within 15
// minutes. Each finding is an event with a key that never repeats, so the
// same thing is never alerted twice. Pure, so tested.

import type { OrderResult } from "@repo/engine-client/types";
import type { MaterialReady } from "../schedule/material";
import { shortDay } from "../schedule/material";

export const ALERT_TYPES = ["late", "down", "material", "rfq"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_TITLE: Record<AlertType, string> = {
  late: "A new order makes another order late",
  down: "A machine is marked down",
  material: "Material arrives after an order's start",
  rfq: "An RFQ from a top-10 customer",
};

/** Who each alert is for: the people who can act on it. */
const ALERT_ROLES: Record<AlertType, readonly string[]> = {
  late: ["owner", "admin", "planner"],
  down: ["owner", "admin", "planner"],
  material: ["owner", "admin", "planner"],
  rfq: ["owner", "admin", "estimator"],
};

export const alertTypesFor = (role: string | null) =>
  ALERT_TYPES.filter((t) => role !== null && ALERT_ROLES[t].includes(role));

export interface AlertFinding {
  key: string;
  message: string;
  path: string;
  type: AlertType;
}

const DAY_MS = 86_400_000;
/** Machine-down days this far ahead are worth an alert now. */
const DOWN_AHEAD_DAYS = 14;
/** Days off for everyone (a holiday) aren't a machine going down. */
const NOT_DOWN = /holiday|closed|shutdown|vacation|christmas|thanksgiving/i;

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

interface CalendarRow {
  date: string;
  hours: number;
  machine: string;
  reason: string | null;
  workCenterId: string;
}

/**
 * Machines marked down (0 hours) today or in the next two weeks. A day every
 * machine has off, or one called a holiday, is the shop closing, not a
 * machine going down.
 */
export const machineDown = (
  days: CalendarRow[],
  machineCount: number,
  today: string
): AlertFinding[] => {
  const end = addDays(today, DOWN_AHEAD_DAYS);
  const zero = days.filter(
    (d) => d.hours <= 0 && d.date >= today && d.date < end
  );
  const perDate = new Map<string, number>();
  for (const d of zero) {
    perDate.set(d.date, (perDate.get(d.date) ?? 0) + 1);
  }
  return zero
    .filter(
      (d) =>
        !(
          (d.reason && NOT_DOWN.test(d.reason)) ||
          (machineCount > 1 && (perDate.get(d.date) ?? 0) >= machineCount)
        )
    )
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.machine.localeCompare(b.machine)
    )
    .map((d) => ({
      type: "down",
      key: `${d.workCenterId}:${d.date}`,
      message: `${d.machine} is down ${d.date === today ? "today" : shortDay(d.date)}${d.reason ? ` (${d.reason})` : ""}.`,
      path: "/schedule/calendar",
    }));
};

interface PlannedStart {
  orderNo: string;
  /** The order's first planned operation, YYYY-MM-DD. */
  start: string;
}

/**
 * Orders on the board whose material now comes later than their planned
 * start: a PO pushed out, or stock used elsewhere. Material nobody ordered
 * is the brief's job, not an alert's.
 */
export const materialLate = (
  starts: PlannedStart[],
  material: Map<string, MaterialReady>
): AlertFinding[] =>
  starts.flatMap((s) => {
    const m = material.get(s.orderNo);
    if (
      !m ||
      m.unknown ||
      m.notOrdered ||
      m.date === null ||
      m.date <= s.start
    ) {
      return [];
    }
    return [
      {
        type: "material",
        key: `${s.orderNo}:${m.date}`,
        message: `${s.orderNo}: material now ready ${shortDay(m.date)}, after its planned start ${shortDay(s.start)} (${m.note}). Re-plan to see the effect.`,
        path: "/schedule",
      } satisfies AlertFinding,
    ];
  });

interface RevenueRow {
  amount: number;
  customerId: string | null;
}

/** The shop's 10 biggest customers by what they ordered. */
export const topCustomers = (rows: RevenueRow[], n = 10) => {
  const total = new Map<string, number>();
  for (const r of rows) {
    if (r.customerId && r.amount > 0) {
      total.set(r.customerId, (total.get(r.customerId) ?? 0) + r.amount);
    }
  }
  return new Set(
    [...total.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([id]) => id)
  );
};

interface NewRfq {
  customer: string;
  customerId: string | null;
  id: string;
  label: string;
}

export const topCustomerRfqs = (
  rfqs: NewRfq[],
  top: Set<string>
): AlertFinding[] =>
  rfqs
    .filter((r) => r.customerId && top.has(r.customerId))
    .map((r) => ({
      type: "rfq",
      key: r.id,
      message: `${r.label} from ${r.customer}, one of your top 10 customers.`,
      path: `/quotes/${r.id}`,
    }));

/**
 * Orders a new order pushes late: on time (or less late) in the plan without
 * the new orders, later with them.
 */
export const lateByNewOrders = (
  without: OrderResult[],
  withNew: OrderResult[],
  newOrders: string[]
): AlertFinding[] => {
  const before = new Map(without.map((o) => [o.order_no, o.days_late]));
  const fresh = new Set(newOrders);
  const by = [...newOrders].sort().join(", ");
  return withNew
    .filter((o) => !fresh.has(o.order_no) && o.days_late > 0)
    .filter((o) => o.days_late > Math.max(0, before.get(o.order_no) ?? 0))
    .map((o) => {
      const was = Math.max(0, before.get(o.order_no) ?? 0);
      return {
        type: "late",
        key: `${o.order_no}:${o.days_late}:${by}`,
        message: `New order ${by} makes ${o.order_no} ${o.days_late} day${o.days_late === 1 ? "" : "s"} late (${was === 0 ? "it was on time" : `it was ${was} day${was === 1 ? "" : "s"} late`}), due ${shortDay(o.due_date)}.`,
        path: "/schedule",
      } satisfies AlertFinding;
    });
};
