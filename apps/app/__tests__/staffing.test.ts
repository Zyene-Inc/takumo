import type { DayLoad } from "@repo/engine-client/types";
import { describe, expect, test } from "vitest";
import { shortStaffed } from "../lib/schedule/staffing";

const day = (
  work_center: string,
  date: string,
  capacity: number,
  machine: number | null
): DayLoad => ({
  work_center,
  date,
  load_minutes: 0,
  capacity_minutes: capacity,
  machine_minutes: machine,
});

describe("short-staffed machine-days on the board", () => {
  test("only days with fewer people than machine hours, soonest first", () => {
    const result = shortStaffed(
      [
        day("VF2", "2026-11-12", 480, 960),
        day("VF2", "2026-11-11", 0, 960),
        day("VF2", "2026-11-10", 960, 960),
        day("LATHE", "2026-11-10", 480, null),
      ],
      "2026-11-09"
    );
    expect(result).toEqual([
      {
        machine: "VF2",
        days: ["Wed Nov 11 (0 of 16 h)", "Thu Nov 12 (8 of 16 h)"],
        more: 0,
      },
    ]);
  });

  test("past days and days beyond the window are left out", () => {
    expect(
      shortStaffed(
        [day("VF2", "2026-11-01", 0, 480), day("VF2", "2026-12-30", 0, 480)],
        "2026-11-09"
      )
    ).toEqual([]);
  });
});
