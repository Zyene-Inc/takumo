import { describe, expect, test } from "vitest";
import {
  attributeDef,
  factLabel,
  formatValue,
  parseFactLabel,
  parseValue,
} from "../lib/facts/attributes";
import {
  type CalibratedOp,
  evidenceFor,
  type FinishedJob,
  MIN_JOBS,
  operationStats,
  setupTrend,
  weeklyError,
  weekOf,
} from "../lib/facts/calibration";
import { buildScheduleRequest, type ShopRows } from "../lib/schedule/request";

describe("fact values", () => {
  const setup = attributeDef("routing", "setupMin");
  const efficiency = attributeDef("work_center", "efficiency");
  const rate = attributeDef("work_center", "hourlyRate");

  test("every subject has a note, and only known attributes exist", () => {
    expect(attributeDef("shop", "note")?.kind).toBe("text");
    expect(attributeDef("part", "setupMin")).toBeNull();
    expect(attributeDef("nope", "note")).toBeNull();
  });

  test("numbers are checked against their range and rounded", () => {
    expect(parseValue(setup!, "120")).toEqual({ ok: true, value: 120 });
    expect(parseValue(setup!, 47.26)).toEqual({ ok: true, value: 47.3 });
    expect(parseValue(setup!, "-5")).toMatchObject({ ok: false });
    expect(parseValue(setup!, "two hours")).toMatchObject({ ok: false });
    expect(parseValue(setup!, "")).toMatchObject({ ok: false });
    expect(parseValue(rate!, "$105.50")).toEqual({ ok: true, value: 105.5 });
  });

  test("efficiency is a fraction, typed either way", () => {
    expect(parseValue(efficiency!, "92")).toEqual({ ok: true, value: 0.92 });
    expect(parseValue(efficiency!, "0.85")).toEqual({ ok: true, value: 0.85 });
    expect(formatValue(efficiency, 0.92)).toBe("92%");
  });

  test("display with units", () => {
    expect(formatValue(setup, 120)).toBe("120 min");
    expect(formatValue(rate, 105.5)).toBe("$105.5/h");
    expect(formatValue(attributeDef("material", "unitCost"), 18.5)).toBe(
      "$18.5"
    );
    expect(
      formatValue(attributeDef("routing", "note"), "Chatters above 1,200 rpm")
    ).toBe("Chatters above 1,200 rpm");
    expect(formatValue(setup, null)).toBe("—");
  });

  test("fact numbers", () => {
    expect(factLabel(12)).toBe("F-12");
    expect(parseFactLabel("f-12")).toBe(12);
    expect(parseFactLabel("F12")).toBe(12);
    expect(parseFactLabel("12x")).toBeNull();
  });
});

const job = (overrides: Partial<FinishedJob>): FinishedJob => ({
  orderNo: "SO-1",
  routingId: "r1",
  actualEnd: new Date("2026-10-07T15:00:00Z"),
  actualSetupMin: 120,
  actualRunMin: 1200,
  plannedSetupMin: 90,
  plannedRunMinPerUnit: 12,
  qty: 100,
  ...overrides,
});

describe("weekly model error", () => {
  test("weeks start on Monday", () => {
    expect(weekOf(new Date("2026-10-07T15:00:00Z"))).toBe("2026-10-05"); // Wednesday
    expect(weekOf(new Date("2026-10-05T00:00:00Z"))).toBe("2026-10-05");
    expect(weekOf(new Date("2026-10-11T23:00:00Z"))).toBe("2026-10-05"); // Sunday
  });

  test("mean absolute % error of planned vs actual, per week", () => {
    const weeks = weeklyError([
      job({ actualSetupMin: 120, plannedSetupMin: 90 }), // 25% off
      job({
        actualSetupMin: 50,
        plannedSetupMin: 45,
        actualRunMin: 600,
        qty: 100,
        plannedRunMinPerUnit: 6,
      }), // 10%, run exact
      job({
        actualEnd: new Date("2026-10-14T10:00:00Z"),
        actualSetupMin: 100,
        plannedSetupMin: 95,
      }), // 5%
      job({
        actualEnd: new Date("2026-10-14T11:00:00Z"),
        plannedSetupMin: null,
        plannedRunMinPerUnit: null,
      }),
    ]);
    expect(weeks).toEqual([
      {
        week: "2026-10-05",
        jobs: 2,
        setupJobs: 2,
        runJobs: 2,
        setupError: 0.175,
        runError: 0,
      },
      {
        week: "2026-10-12",
        jobs: 2,
        setupJobs: 1,
        runJobs: 1,
        setupError: 0.05,
        runError: 0,
      },
    ]);
  });

  test("the trend says whether setup error fell, and for how long", () => {
    const weeks = [0.3, 0.25, 0.28, 0.2, 0.12].map((e, i) => ({
      week: `2026-09-${String(7 + i * 7).padStart(2, "0")}`,
      jobs: 4,
      setupJobs: 4,
      runJobs: 4,
      setupError: e,
      runError: 0.05,
    }));
    const trend = setupTrend(weeks);
    expect(trend.dropping).toBe(true);
    expect(trend.streak).toBe(2);
    expect(trend.latest?.setupError).toBe(0.12);
    expect(setupTrend(weeks.slice(0, 3)).dropping).toBe(false);
    expect(setupTrend(weeks.slice(0, 1)).dropping).toBeNull();
  });
});

describe("recalibration", () => {
  const now = new Date("2026-11-01T00:00:00Z");
  const op: CalibratedOp = {
    id: "r1",
    label: "P-2001 rev C op 10 (OKUMA-LB3000)",
    setupMin: 90,
    runMinPerUnit: 12,
    setupSince: null,
    runSince: null,
  };
  const jobs = [112, 120, 122, 135].map((s, i) =>
    job({
      orderNo: `SO-49${i}`,
      actualSetupMin: s,
      actualRunMin: 1220,
      actualEnd: new Date(`2026-10-0${i + 2}T15:00:00Z`),
    })
  );

  test("proposes the median when enough jobs are well off the routing", () => {
    const stats = operationStats([op], jobs, now);
    const setup = stats.find((s) => s.attribute === "setupMin");
    expect(setup).toMatchObject({
      propose: true,
      value: 121,
      current: 90,
      min: 112,
      max: 135,
    });
    // Run time is 12.2 vs 12: under the 10% threshold.
    expect(stats.find((s) => s.attribute === "runMinPerUnit")?.propose).toBe(
      false
    );
    expect(evidenceFor(setup!)).toBe(
      "Median of 4 jobs finished Oct 2 – Oct 5: 121 min setup (range 112–135), vs 90 in the routing. Orders: SO-490, SO-491, SO-492, SO-493."
    );
  });

  test(`needs ${MIN_JOBS} jobs`, () => {
    const stats = operationStats([op], jobs.slice(0, MIN_JOBS - 1), now);
    expect(stats.find((s) => s.attribute === "setupMin")?.propose).toBe(false);
  });

  test("small differences aren't worth a change", () => {
    const close = jobs.map((j) => ({ ...j, actualSetupMin: 94 }));
    expect(operationStats([op], close, now).some((s) => s.propose)).toBe(false);
  });

  test("only jobs after the last approved change count", () => {
    const changed = {
      ...op,
      setupMin: 121,
      setupSince: new Date("2026-10-04T00:00:00Z"),
    };
    const stats = operationStats([changed], jobs, now);
    const setup = stats.find((s) => s.attribute === "setupMin");
    expect(setup?.jobs.map((j) => j.orderNo)).toEqual(["SO-492", "SO-493"]);
    expect(setup?.propose).toBe(false);
  });

  test("old jobs and other operations are ignored", () => {
    const old = jobs.map((j) => ({
      ...j,
      actualEnd: new Date("2026-03-01T00:00:00Z"),
    }));
    const other = jobs.map((j) => ({ ...j, routingId: "r2" }));
    expect(operationStats([op], [...old, ...other], now)).toEqual([]);
  });
});

describe("planning around finished operations", () => {
  const shop = (doneSeqs: number[]): ShopRows => ({
    workCenters: [
      {
        id: "wc1",
        name: "MILL",
        efficiency: 1,
        hourlyRate: null,
        shifts: { hoursPerDay: 8 },
        calendar: [],
      },
      {
        id: "wc2",
        name: "DEBURR",
        efficiency: 1,
        hourlyRate: null,
        shifts: { hoursPerDay: 8 },
        calendar: [],
      },
    ],
    parts: [
      {
        id: "p1",
        partNo: "P-1",
        rev: "A",
        material: null,
        routings: [
          {
            seq: 10,
            workCenterId: "wc1",
            setupMin: 30,
            runMinPerUnit: 2,
            altWorkCenterIds: [],
          },
          {
            seq: 20,
            workCenterId: "wc2",
            setupMin: 5,
            runMinPerUnit: 1,
            altWorkCenterIds: [],
          },
        ],
      },
    ],
    orders: [
      {
        orderNo: "SO-1",
        partId: "p1",
        qty: 10,
        dueDate: new Date("2026-11-20"),
        priority: 0,
        price: null,
        doneSeqs,
      },
    ],
    pins: [],
  });

  test("only the operations still to do are planned", () => {
    const { request } = buildScheduleRequest(shop([10]), "2026-11-02");
    expect(request.orders[0].part_no).toBe("P-1 after op 10");
    expect(
      request.parts
        .find((p) => p.part_no === "P-1 after op 10")
        ?.routing.map((r) => r.seq)
    ).toEqual([20]);
    expect(request.parts.some((p) => p.part_no === "P-1")).toBe(false);
  });

  test("an order with nothing left isn't planned", () => {
    const built = buildScheduleRequest(shop([10, 20]), "2026-11-02");
    expect(built.request.orders).toEqual([]);
    expect(built.skipped[0].reason).toMatch(/every operation is finished/);
  });

  test("nothing finished: the whole routing, as before", () => {
    const { request } = buildScheduleRequest(shop([]), "2026-11-02");
    expect(request.orders[0].part_no).toBe("P-1");
    expect(request.parts[0].routing).toHaveLength(2);
  });
});

describe("shop-floor logs", () => {
  const log = {
    orderId: "o1",
    seq: 10,
    setupMin: 50,
    runMin: 600,
    qtyGood: 99,
    qtyScrap: 1,
  };

  test("a complete log passes", async () => {
    const { checkLog } = await import("../lib/floor/check");
    expect(checkLog(log)).toBeNull();
  });

  test("bad numbers, no parts and future finishes are refused", async () => {
    const { checkLog } = await import("../lib/floor/check");
    expect(checkLog({ ...log, setupMin: -1 })).toMatch(/minutes/);
    expect(checkLog({ ...log, qtyGood: 1.5 })).toMatch(/whole numbers/);
    expect(checkLog({ ...log, qtyGood: 0, qtyScrap: 0 })).toMatch(/how many/);
    const now = new Date("2026-11-02T12:00:00Z");
    expect(
      checkLog({ ...log, finishedAt: new Date("2026-11-03T12:00:00Z") }, now)
    ).toMatch(/future/);
    expect(
      checkLog({ ...log, finishedAt: new Date("2026-11-02T11:00:00Z") }, now)
    ).toBeNull();
  });
});
