// Who runs what, from the engine's assignments (F3.3 v2).
import type { OperatorAssignment } from "@repo/engine-client/types";
import { describe, expect, test } from "vitest";
import {
  byOperation,
  crewNames,
  crewText,
  firstDayFrom,
  onDay,
} from "../lib/schedule/crew";

const a = (
  operator: string,
  start: string,
  end: string,
  over: Partial<OperatorAssignment> = {}
): OperatorAssignment => ({
  order_no: "SO-1",
  seq: 10,
  work_center: "HAAS-VF2",
  operator_id: operator.toLowerCase(),
  operator,
  start_at: start,
  end_at: end,
  minutes: 0,
  setup_only: false,
  ...over,
});

const handover = [
  a("Sam", "2026-11-02T07:00:00", "2026-11-02T15:00:00", { minutes: 480 }),
  a("Ana", "2026-11-02T15:00:00", "2026-11-02T19:00:00", { minutes: 240 }),
];

describe("who runs an operation", () => {
  test("one day: the people and their hours", () => {
    expect(crewText(handover)).toBe("Sam 07:00–15:00, Ana 15:00–19:00");
    expect(crewNames(handover)).toBe("Sam, Ana");
  });

  test("over several days: each day named", () => {
    const twoDays = [
      ...handover,
      a("Sam", "2026-11-03T07:00:00", "2026-11-03T09:00:00"),
    ];
    expect(crewText(twoDays)).toBe(
      "Mon Nov 2: Sam 07:00–15:00, Ana 15:00–19:00; Tue Nov 3: Sam 07:00–09:00"
    );
    expect(crewNames(twoDays)).toBe("Sam, Ana");
  });

  test("lights-out: only the setup has a person", () => {
    expect(
      crewText([
        a("Sam", "2026-11-02T07:00:00", "2026-11-02T08:00:00", {
          setup_only: true,
        }),
      ])
    ).toBe("Sam 07:00–08:00 (setup, then it runs on its own)");
  });

  test("grouped by operation, in time order", () => {
    const other = a("Bo", "2026-11-02T06:00:00", "2026-11-02T07:00:00", {
      order_no: "SO-2",
    });
    const map = byOperation([handover[1], other, handover[0]]);
    expect(map.get("SO-1#10")?.map((x) => x.operator)).toEqual(["Sam", "Ana"]);
    expect(map.get("SO-2#10")?.map((x) => x.operator)).toEqual(["Bo"]);
  });
});

describe("who's on what on a day", () => {
  const all = [
    ...handover,
    a("Sam", "2026-11-02T11:00:00", "2026-11-02T13:00:00", {
      order_no: "SO-3",
      work_center: "LATHE-1",
      minutes: 120,
    }),
    a("Ana", "2026-11-03T15:00:00", "2026-11-03T16:00:00", { minutes: 60 }),
  ];

  test("each person's stretches, earliest first, with hours booked", () => {
    const people = onDay(all, "2026-11-02");
    expect(people.map((p) => p.operator)).toEqual(["Sam", "Ana"]);
    expect(people[0].items.map((x) => x.order_no)).toEqual(["SO-1", "SO-3"]);
    expect(people[0].minutes).toBe(600);
    expect(onDay(all, "2026-11-03").map((p) => p.operator)).toEqual(["Ana"]);
  });

  test("the first day from today with anyone on it", () => {
    expect(firstDayFrom(all, "2026-11-01")).toBe("2026-11-02");
    expect(firstDayFrom(all, "2026-11-03")).toBe("2026-11-03");
    expect(firstDayFrom(all, "2026-11-04")).toBeNull();
    expect(firstDayFrom([], "2026-11-01")).toBeNull();
  });
});
