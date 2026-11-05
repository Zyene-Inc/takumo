// Machine-days with fewer people than the machine has hours (F3.1-R5): the
// engine plans those days only for the hours someone qualified is in, and
// the board says so. Pure, so tested.

import type { DayLoad } from "@repo/engine-client/types";
import { shortDay } from "./material";

export interface ShortStaffed {
  /** e.g. "Thu Nov 12 (8 of 16 h)", soonest first. */
  days: string[];
  machine: string;
  more: number;
}

/** Days shown per machine; the rest are counted. */
const SHOWN = 3;

const hours = (minutes: number) => Number((minutes / 60).toFixed(1));

/** Short-staffed days per machine from `from` up to `days` days on. */
export const shortStaffed = (
  load: DayLoad[],
  from: string,
  days = 14
): ShortStaffed[] => {
  const until = new Date(Date.parse(`${from}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const byMachine = new Map<string, DayLoad[]>();
  for (const d of load) {
    const machine = d.machine_minutes ?? d.capacity_minutes;
    if (d.date < from || d.date >= until || machine <= d.capacity_minutes) {
      continue;
    }
    const list = byMachine.get(d.work_center) ?? [];
    list.push(d);
    byMachine.set(d.work_center, list);
  }
  return [...byMachine.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([machine, list]) => {
      const sorted = list.sort((a, b) => a.date.localeCompare(b.date));
      return {
        machine,
        days: sorted
          .slice(0, SHOWN)
          .map(
            (d) =>
              `${shortDay(d.date)} (${hours(d.capacity_minutes)} of ${hours(d.machine_minutes ?? 0)} h)`
          ),
        more: Math.max(0, sorted.length - SHOWN),
      };
    });
};
