// Who runs each operation of the plan, and who's on what today (F3.3 v2),
// from the engine's assignments. Pure, so tested.

import type { OperatorAssignment } from "@repo/engine-client/types";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "07:00" from the engine's shop-local "2026-11-02T07:00:00". */
export const clock = (at: string) => at.slice(11, 16);

/** "Mon Nov 2" from "2026-11-02T…". */
const dayLabel = (at: string) => {
  const d = new Date(`${at.slice(0, 10)}T00:00:00Z`);
  return `${WEEKDAY[d.getUTCDay()]} ${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

export const opKey = (orderNo: string, seq: number) => `${orderNo}#${seq}`;

/** Each operation's assignments, in time order. */
export const byOperation = (assignments: readonly OperatorAssignment[]) => {
  const out = new Map<string, OperatorAssignment[]>();
  for (const a of [...assignments].sort((x, y) =>
    x.start_at.localeCompare(y.start_at)
  )) {
    const key = opKey(a.order_no, a.seq);
    out.set(key, [...(out.get(key) ?? []), a]);
  }
  return out;
};

const stretch = (a: OperatorAssignment) =>
  `${a.operator} ${clock(a.start_at)}–${clock(a.end_at)}${a.setup_only ? " (setup, then it runs on its own)" : ""}`;

/**
 * "Sam 07:00–15:00, Ana 15:00–19:00", with the day in front when the
 * operation runs over several: "Mon Nov 2: Sam 07:00–15:00; Tue Nov 3: …".
 */
export const crewText = (assignments: readonly OperatorAssignment[]) => {
  const days = new Map<string, OperatorAssignment[]>();
  for (const a of assignments) {
    const day = a.start_at.slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), a]);
  }
  if (days.size <= 1) {
    return assignments.map(stretch).join(", ");
  }
  return [...days.values()]
    .map(
      (list) => `${dayLabel(list[0].start_at)}: ${list.map(stretch).join(", ")}`
    )
    .join("; ");
};

/** Just the names, in order, once each: "Sam, Ana". */
export const crewNames = (assignments: readonly OperatorAssignment[]) =>
  [...new Set(assignments.map((a) => a.operator))].join(", ");

export interface PersonDay {
  items: OperatorAssignment[];
  /** Minutes booked that day (a machine at half a person counts in full). */
  minutes: number;
  operator: string;
  operatorId: string;
}

/** Who's on what on a day (shop-local "YYYY-MM-DD"), by person, earliest first. */
export const onDay = (
  assignments: readonly OperatorAssignment[],
  day: string
): PersonDay[] => {
  const people = new Map<string, PersonDay>();
  for (const a of assignments) {
    if (a.start_at.slice(0, 10) !== day) {
      continue;
    }
    const person = people.get(a.operator_id) ?? {
      operatorId: a.operator_id,
      operator: a.operator,
      items: [],
      minutes: 0,
    };
    person.items.push(a);
    person.minutes += a.minutes;
    people.set(a.operator_id, person);
  }
  for (const person of people.values()) {
    person.items.sort((x, y) => x.start_at.localeCompare(y.start_at));
  }
  return [...people.values()].sort(
    (x, y) =>
      x.items[0].start_at.localeCompare(y.items[0].start_at) ||
      x.operator.localeCompare(y.operator)
  );
};

/** The first day on or after `from` that has anyone on it, or null. */
export const firstDayFrom = (
  assignments: readonly OperatorAssignment[],
  from: string
) =>
  assignments
    .map((a) => a.start_at.slice(0, 10))
    .filter((d) => d >= from)
    .sort()[0] ?? null;
