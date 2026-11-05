// Pure helpers for the schedule board: time ↔ pixels, machine calendars and
// drag checks. No React, so they're unit-tested.

import type {
  ScheduledOperation,
  ScheduleRequest,
  WorkCenter,
} from "@repo/engine-client/types";

const DAY_MS = 86_400_000;
const WEEKDAYS = [0, 1, 2, 3, 4];

/** Engine clock times have no zone; treat them as UTC so days line up. */
const clockMs = (value: string) =>
  Date.parse(value.length === 10 ? `${value}T00:00:00Z` : `${value}Z`);

export const addDays = (isoDate: string, days: number) =>
  new Date(clockMs(isoDate) + days * DAY_MS).toISOString().slice(0, 10);

export const daysBetween = (from: string, to: string) =>
  Math.round((clockMs(to) - clockMs(from)) / DAY_MS);

/** Monday = 0, like the engine. */
const weekday = (isoDate: string) =>
  (new Date(clockMs(isoDate)).getUTCDay() + 6) % 7;

/** Hours a machine runs on a day (0 = closed), mirroring WorkCenter.hours_on. */
export const hoursOn = (wc: WorkCenter, isoDate: string) => {
  const exception = wc.exceptions?.find((e) => e.date === isoDate);
  if (exception) {
    return exception.hours;
  }
  return (wc.working_days ?? WEEKDAYS).includes(weekday(isoDate))
    ? wc.hours_per_day
    : 0;
};

export const closedReason = (wc: WorkCenter, isoDate: string) => {
  const exception = wc.exceptions?.find((e) => e.date === isoDate);
  if (exception && exception.hours === 0) {
    return exception.reason || "Closed";
  }
  return hoursOn(wc, isoDate) === 0 ? "Not a working day" : null;
};

/** The days the board shows: plan start to a little past the last operation. */
export const boardDays = (
  startDate: string,
  operations: readonly ScheduledOperation[],
  minDays = 14
) => {
  const last = operations.reduce(
    (latest, op) => (op.end_date > latest ? op.end_date : latest),
    startDate
  );
  const count = Math.max(minDays, daysBetween(startDate, last) + 3);
  return Array.from({ length: count }, (_, i) => addDays(startDate, i));
};

/** Bar position in pixels from the board's first day. */
export const barGeometry = (
  op: Pick<ScheduledOperation, "start_at" | "end_at">,
  startDate: string,
  dayWidth: number
) => {
  const origin = clockMs(startDate);
  const left = ((clockMs(op.start_at) - origin) / DAY_MS) * dayWidth;
  const right = ((clockMs(op.end_at) - origin) / DAY_MS) * dayWidth;
  return { left, width: Math.max(4, right - left) };
};

/** Machines an operation may run on: its routing's primary plus alternates. */
export const allowedMachines = (
  request: ScheduleRequest,
  orderNo: string,
  seq: number
) => {
  const order = request.orders.find((o) => o.order_no === orderNo);
  const op = request.parts
    .find((p) => p.part_no === order?.part_no)
    ?.routing.find((r) => r.seq === seq);
  return op ? [op.work_center, ...(op.alt_work_centers ?? [])] : [];
};

/** Why an operation can't be dropped there, or null if it can. */
export const moveProblem = (
  request: ScheduleRequest,
  op: Pick<ScheduledOperation, "order_no" | "seq">,
  machine: string,
  day: string
) => {
  if (day < request.start_date) {
    return "Operations can only move to today or later.";
  }
  if (!allowedMachines(request, op.order_no, op.seq).includes(machine)) {
    return `Op ${op.seq} can't run on ${machine}.`;
  }
  const wc = request.work_centers.find((w) => w.name === machine);
  const closed = wc ? closedReason(wc, day) : "Unknown machine";
  return closed
    ? `${machine} isn't running that day (${closed.toLowerCase()}).`
    : null;
};

/** Theme-friendly hue for an order, stable across re-plans (from its number). */
const HUES = [186, 28, 262, 142, 330, 48, 210, 0, 100, 290];
export const orderHue = (orderNo: string) => {
  let hash = 0;
  for (const char of orderNo) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
  }
  return HUES[hash % HUES.length];
};

type OrderRisk = "late" | "tight" | "ok";

/** Late = after the due date; tight = finishes on the due date or the day before. */
export const orderRisk = (completion: string, due: string): OrderRisk => {
  const slack = daysBetween(completion, due);
  if (slack < 0) {
    return "late";
  }
  return slack <= 1 ? "tight" : "ok";
};

export const fmtDay = (isoDate: string, style: "short" | "long" = "short") =>
  new Date(clockMs(isoDate)).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(style === "long" ? { year: "numeric" } : {}),
  });

export const fmtTime = (clock: string) =>
  new Date(clockMs(clock)).toLocaleString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export const fmtHours = (minutes: number) => {
  const hours = minutes / 60;
  return hours >= 10
    ? `${Math.round(hours)} h`
    : `${Number(hours.toFixed(1))} h`;
};

/** Local date (YYYY-MM-DD) on the viewer's computer: the plan starts today. */
export const localToday = () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};
