import type { ScheduleRequest } from "@repo/engine-client/types";
import { describe, expect, test } from "vitest";
import {
  addDays,
  barGeometry,
  boardDays,
  closedReason,
  hoursOn,
  moveProblem,
  orderRisk,
} from "../app/(authenticated)/schedule/gantt";
import {
  buildScheduleRequest,
  checkToday,
  DEFAULT_HOURS_PER_DAY,
  planFingerprint,
  type ShopRows,
} from "../lib/schedule/request";

const START = "2026-11-02"; // a Monday
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const shop = (): ShopRows => ({
  workCenters: [
    {
      id: "wc1",
      name: "MILL",
      efficiency: 0.9,
      hourlyRate: { toString: () => "95" },
      shifts: { hoursPerDay: 16 },
      calendar: [
        { date: day("2026-11-26"), availableHours: 0, reason: "Thanksgiving" },
        { date: day("2026-10-01"), availableHours: 0, reason: "Past" },
      ],
    },
    {
      id: "wc2",
      name: "LATHE",
      efficiency: 1,
      hourlyRate: null,
      shifts: { hoursPerDay: 8, days: [1, 2, 3, 4, 5, 6] },
      calendar: [],
    },
    {
      id: "wc3",
      name: "DEBURR",
      efficiency: 1,
      hourlyRate: null,
      shifts: null,
      calendar: [],
    },
  ],
  parts: [
    {
      id: "p1",
      partNo: "P-1",
      rev: "A",
      material: { unit: "ea", unitCost: { toString: () => "12.5" } },
      routings: [
        {
          seq: 20,
          workCenterId: "wc3",
          setupMin: 5,
          runMinPerUnit: 1,
          altWorkCenterIds: [],
        },
        {
          seq: 10,
          workCenterId: "wc1",
          setupMin: 30,
          runMinPerUnit: 4,
          altWorkCenterIds: ["wc2", "gone"],
        },
      ],
    },
    {
      id: "p2",
      partNo: "P-2",
      rev: "A",
      material: { unit: "ft", unitCost: { toString: () => "3" } },
      routings: [
        {
          seq: 10,
          workCenterId: "wc2",
          setupMin: 0,
          runMinPerUnit: 2,
          altWorkCenterIds: [],
        },
      ],
    },
    { id: "p3", partNo: "P-3", rev: "A", material: null, routings: [] },
    {
      id: "p2b",
      partNo: "P-2",
      rev: "B",
      material: null,
      routings: [
        {
          seq: 10,
          workCenterId: "wc2",
          setupMin: 0,
          runMinPerUnit: 2,
          altWorkCenterIds: [],
        },
      ],
    },
  ],
  orders: [
    {
      orderNo: "SO-2",
      partId: "p2",
      qty: 10,
      dueDate: day("2026-11-20"),
      priority: 0,
      price: null,
    },
    {
      orderNo: "SO-1",
      partId: "p1",
      qty: 100,
      dueDate: day("2026-11-13"),
      priority: 2,
      price: { toString: () => "4200" },
    },
    {
      orderNo: "SO-3",
      partId: "p3",
      qty: 5,
      dueDate: day("2026-11-13"),
      priority: 0,
      price: null,
    },
  ],
  pins: [
    {
      orderNo: "SO-1",
      routingSeq: 10,
      workCenterId: "wc2",
      plannedStart: new Date("2026-11-04T09:30:00Z"),
    },
    // Not allowed: DEBURR isn't an alternate for op 10.
    {
      orderNo: "SO-1",
      routingSeq: 20,
      workCenterId: "wc1",
      plannedStart: day("2026-11-05"),
    },
    // In the past: dropped.
    {
      orderNo: "SO-2",
      routingSeq: 10,
      workCenterId: "wc2",
      plannedStart: day("2026-10-30"),
    },
  ],
});

describe("buildScheduleRequest", () => {
  const built = buildScheduleRequest(shop(), START);
  const { request } = built;

  test("maps machines with hours, working days, rates and future downtime", () => {
    const [mill, lathe, deburr] = request.work_centers;
    expect(mill).toMatchObject({
      name: "MILL",
      hours_per_day: 16,
      efficiency: 0.9,
      hourly_rate: 95,
      exceptions: [{ date: "2026-11-26", hours: 0, reason: "Thanksgiving" }],
    });
    expect(lathe.working_days).toEqual([0, 1, 2, 3, 4, 5]);
    expect(deburr.hours_per_day).toBe(DEFAULT_HOURS_PER_DAY);
    expect(built.assumptions).toEqual([
      `DEBURR has no hours per day; assumed ${DEFAULT_HOURS_PER_DAY} h.`,
    ]);
  });

  test("routings are sorted, use machine names, and drop unknown alternates", () => {
    const part =
      request.parts.find((p) => p.part_no === "P-2 rev A") ?? request.parts[0];
    expect(request.parts.find((p) => p.part_no === "P-1")).toEqual({
      part_no: "P-1",
      material_cost: 12.5, // priced per each
      routing: [
        {
          seq: 10,
          work_center: "MILL",
          setup_min: 30,
          run_min_per_unit: 4,
          alt_work_centers: ["LATHE"],
        },
        {
          seq: 20,
          work_center: "DEBURR",
          setup_min: 5,
          run_min_per_unit: 1,
          alt_work_centers: [],
        },
      ],
    });
    // Material by the foot can't be costed per part.
    expect(part.material_cost).toBeNull();
  });

  test("two revs of one part number get distinct keys", () => {
    expect(built.partKeys).toMatchObject({
      p1: "P-1",
      p2: "P-2 rev A",
      p2b: "P-2 rev B",
    });
  });

  test("orders without a routing are skipped with a reason", () => {
    expect(request.orders.map((o) => o.order_no)).toEqual(["SO-1", "SO-2"]);
    expect(request.orders[0]).toMatchObject({
      due_date: "2026-11-13",
      priority: 2,
      price: 4200,
    });
    expect(built.skipped).toEqual([
      { orderNo: "SO-3", reason: "P-3 has no routing" },
    ]);
  });

  test("keeps only pins the engine can honour", () => {
    expect(request.pins).toEqual([
      {
        order_no: "SO-1",
        seq: 10,
        work_center: "LATHE",
        start_date: "2026-11-04",
      },
    ]);
  });

  test("includeParts and materialCost", () => {
    const withExtra = buildScheduleRequest(shop(), START, {
      includeParts: ["p2b", "p3"],
      materialCost: { p2b: 7 },
    });
    const extra = withExtra.request.parts.find(
      (p) => p.part_no === "P-2 rev B"
    );
    expect(extra?.material_cost).toBe(7);
    // A part with no routing can't be scheduled, so it isn't added.
    expect(withExtra.request.parts.some((p) => p.part_no === "P-3")).toBe(
      false
    );
  });

  test("the fingerprint ignores the start day and key order", () => {
    const later = buildScheduleRequest(shop(), "2026-11-03").request;
    const reordered = JSON.parse(JSON.stringify(request)) as ScheduleRequest;
    expect(planFingerprint({ ...reordered, start_date: "x" })).toBe(
      planFingerprint(request)
    );
    // A different start can drop past pins/downtime, which does change it.
    expect(typeof planFingerprint(later)).toBe("string");
    const changed = buildScheduleRequest(
      {
        ...shop(),
        orders: shop().orders.map((o) => ({ ...o, qty: o.qty + 1 })),
      },
      START
    ).request;
    expect(planFingerprint(changed)).not.toBe(planFingerprint(request));
  });
});

describe("checkToday", () => {
  const now = new Date("2026-11-02T15:00:00Z");
  test("accepts the browser's date within two days of the server's", () => {
    expect(checkToday("2026-11-02", now)).toBe("2026-11-02");
    expect(checkToday("2026-11-01", now)).toBe("2026-11-01");
  });
  test("rejects nonsense and far-off dates", () => {
    expect(checkToday("2026-10-01", now)).toBeNull();
    expect(checkToday("not-a-date", now)).toBeNull();
  });
});

describe("gantt helpers", () => {
  const request = buildScheduleRequest(shop(), START).request;
  const [mill, lathe] = request.work_centers;

  test("calendar", () => {
    expect(hoursOn(mill, "2026-11-02")).toBe(16);
    expect(hoursOn(mill, "2026-11-07")).toBe(0); // Saturday
    expect(hoursOn(lathe, "2026-11-07")).toBe(8); // runs Saturdays
    expect(closedReason(mill, "2026-11-26")).toBe("Thanksgiving");
    expect(closedReason(mill, "2026-11-08")).toBe("Not a working day");
    expect(closedReason(mill, "2026-11-09")).toBeNull();
  });

  test("bars are placed in days from the board start", () => {
    expect(
      barGeometry(
        { start_at: "2026-11-03T06:00:00", end_at: "2026-11-03T18:00:00" },
        START,
        100
      )
    ).toEqual({ left: 125, width: 50 });
  });

  test("the board spans at least two weeks and past the last operation", () => {
    expect(boardDays(START, [])).toHaveLength(14);
    const days = boardDays(START, [
      {
        order_no: "A",
        seq: 10,
        work_center: "MILL",
        start_date: START,
        end_date: "2026-11-30",
        start_at: "2026-11-02T07:00:00",
        end_at: "2026-11-30T10:00:00",
        minutes: 100,
        pinned: false,
      },
    ]);
    expect(days.at(-1)).toBe(addDays("2026-11-30", 2));
  });

  test("moves are checked before asking the server", () => {
    const op = { order_no: "SO-1", seq: 10 };
    expect(moveProblem(request, op, "LATHE", "2026-11-05")).toBeNull();
    expect(moveProblem(request, op, "DEBURR", "2026-11-05")).toContain(
      "can't run on DEBURR"
    );
    expect(moveProblem(request, op, "MILL", "2026-11-26")).toContain(
      "thanksgiving"
    );
    expect(moveProblem(request, op, "MILL", "2026-11-01")).toContain(
      "today or later"
    );
  });

  test("risk", () => {
    expect(orderRisk("2026-11-14", "2026-11-13")).toBe("late");
    expect(orderRisk("2026-11-12", "2026-11-13")).toBe("tight");
    expect(orderRisk("2026-11-10", "2026-11-13")).toBe("ok");
  });
});
