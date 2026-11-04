// @vitest-environment node
// Phase 3 end to end against a running engine: shop rows → the app's own
// request mapping (operators, shifts, time off, material dates) → the
// engine's HTTP API → an answer that names people and material. Runs only
// with TEST_ENGINE_URL set (e.g. TEST_ENGINE_URL=http://127.0.0.1:8077 after starting
// a local engine). Never ENGINE_URL: in deploy builds that is the real
// engine, and a test must not call production.

import type {
  CapacityRequest,
  CapacityResponse,
  ScheduleRequest,
  ScheduleResponse,
} from "@repo/engine-client/types";
import { describe, expect, test } from "vitest";
import { materialReady } from "../lib/schedule/material";
import { buildScheduleRequest } from "../lib/schedule/request";

/** The engine's HTTP API, posted exactly as @repo/engine-client posts it. */
const post = async <T>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(new URL(path, process.env.TEST_ENGINE_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
};
const schedule = (r: ScheduleRequest) => post<ScheduleResponse>("/schedule", r);
const checkCapacity = (r: CapacityRequest) =>
  post<CapacityResponse>("/capacity", r);

const START = "2026-11-09"; // a Monday
const VF2 = /HAAS-VF2/;
const PEOPLE_WORDS = /people|qualified|no one/;
const MODEL_NAMES = /gemini|claude|openai|vertex/i;
const day = (offset: number) =>
  new Date(Date.parse(`${START}T00:00:00Z`) + offset * 86_400_000);
const iso = (d: Date) => d.toISOString().slice(0, 10);

const machine = (id: string, name: string) => ({
  id,
  name,
  efficiency: 1,
  hourlyRate: { toString: () => "90" },
  shifts: { hoursPerDay: 8 },
  calendar: [],
  operatorsPerMachine: 1,
  unattendedRuns: false,
});

const shop = (samOff: boolean) => {
  const operators = [
    {
      id: "sam",
      name: "Sam",
      active: true,
      canRunUnattended: false,
      shifts: { start: "07:00", end: "15:00", days: [1, 2, 3, 4, 5] },
      workCenterIds: ["vf2"],
      // A week's vacation from the plan start.
      days: samOff
        ? [0, 1, 2, 3, 4].map((d) => ({
            date: day(d),
            hours: 0,
            reason: "Vacation",
          }))
        : [],
    },
    {
      id: "ana",
      name: "Ana",
      active: true,
      canRunUnattended: false,
      shifts: { start: "07:00", end: "15:00", days: [1, 2, 3, 4, 5] },
      workCenterIds: ["lathe"],
      days: [],
    },
  ];
  const rows = {
    workCenters: [machine("vf2", "HAAS-VF2"), machine("lathe", "LATHE-1")],
    parts: [
      {
        id: "p1",
        partNo: "BRK-2201",
        rev: "C",
        material: null,
        routings: [
          {
            seq: 10,
            workCenterId: "vf2",
            setupMin: 60,
            runMinPerUnit: 12,
            altWorkCenterIds: [],
          },
        ],
      },
    ],
    orders: [],
    pins: [],
    operators,
  };
  return rows;
};

/** Material: none on hand, 40 ft arriving on PO-4471 on Thu Nov 12. */
const material = (qty: number) =>
  materialReady({
    today: START,
    orders: [],
    extra: {
      orderNo: "NEW-1",
      partId: "p1",
      qty,
      dueDate: day(4),
      started: false,
    },
    stock: [],
    pos: [
      {
        poNo: "PO-4471",
        materialId: "al",
        qtyOrdered: 40,
        qtyReceived: 0,
        unit: "ft",
        status: "open",
        dueDate: day(3),
      },
    ],
    materials: new Map([
      ["al", { name: "6061 2in bar", unit: "ft", leadTimeDays: 10 }],
    ]),
    parts: new Map([["p1", { materialId: "al", qtyPerUnit: 0.5, unit: "ft" }]]),
  }).get("NEW-1");

describe.skipIf(!process.env.TEST_ENGINE_URL)("Phase 3 end to end", () => {
  test("the roster reaches the engine, and a machine nobody's in for is short", async () => {
    // One open order, so there's a plan to look at.
    const built = buildScheduleRequest(
      {
        ...shop(true),
        orders: [
          {
            orderNo: "SO-1",
            partId: "p1",
            qty: 10,
            dueDate: day(11),
            priority: 0,
            price: null,
          },
        ],
      },
      START
    );
    expect(built.request.operators?.map((o) => o.name)).toEqual(["Sam", "Ana"]);
    expect(built.request.operators?.[0]?.shifts?.[0]).toEqual({
      start: "07:00",
      end: "15:00",
      days: [0, 1, 2, 3, 4],
    });
    expect(built.request.operators?.[0]?.time_off).toHaveLength(5);
    const plan = await schedule({ ...built.request, time_limit_s: 5 });
    expect(["OPTIMAL", "FEASIBLE", "HEURISTIC"]).toContain(plan.status);
    // Sam is off all week: HAAS-VF2 has its 8 h but nobody to run it.
    const monday = plan.load.find(
      (d) => d.work_center === "HAAS-VF2" && d.date === START
    );
    expect(monday?.machine_minutes).toBe(480);
    expect(monday?.capacity_minutes).toBe(0);
  });

  test("the plan names who runs each operation, on their shift (v2)", async () => {
    const built = buildScheduleRequest(
      {
        ...shop(false),
        orders: [
          {
            orderNo: "SO-1",
            partId: "p1",
            qty: 30,
            dueDate: day(11),
            priority: 0,
            price: null,
          },
        ],
      },
      START
    );
    const plan = await schedule({ ...built.request, time_limit_s: 5 });
    const assignments = plan.assignments ?? [];
    // 60 + 30 × 12 = 420 min on HAAS-VF2, all of it Sam's, inside 07:00–15:00.
    expect(assignments.length).toBeGreaterThan(0);
    expect(new Set(assignments.map((x) => x.operator))).toEqual(
      new Set(["Sam"])
    );
    expect(assignments.reduce((n, x) => n + x.minutes, 0)).toBe(420);
    for (const x of assignments) {
      expect(x.work_center).toBe("HAAS-VF2");
      expect(x.start_at.slice(11, 16) >= "07:00").toBe(true);
      expect(x.end_at.slice(11, 16) <= "15:00").toBe(true);
    }
    expect(plan.notices ?? []).not.toContainEqual(
      expect.stringContaining("Nobody qualified is free")
    );
  });

  test("a no names people and material, and offers both ways out", async () => {
    const qty = 30; // 60 + 30×12 = 420 min on HAAS-VF2
    const ready = material(qty);
    expect(ready?.date).toBe(iso(day(3)));
    const built = buildScheduleRequest(shop(true), START, {
      includeParts: ["p1"],
    });
    const answer = await checkCapacity({
      ...built.request,
      time_limit_s: 6,
      new_order: {
        order_no: "NEW-1",
        part_no: built.partKeys.p1 ?? "BRK-2201",
        qty,
        due_date: iso(day(4)),
        priority: 0,
        release_date: ready?.date ?? null,
        release_note: ready?.note ?? null,
      },
    });
    expect(answer.can_take).toBe(false);
    // People: Sam's vacation leaves HAAS-VF2 without anyone qualified.
    expect(answer.explanation).toMatch(VF2);
    expect(answer.explanation.toLowerCase()).toMatch(PEOPLE_WORDS);
    // Material, in words, from the app's own note.
    expect(answer.explanation).toContain("PO-4471");
    const kinds = answer.levers.map((l) => l.kind);
    expect(kinds).toContain("extra_operator");
    // No model or provider names in what people read.
    expect(answer.explanation).not.toMatch(MODEL_NAMES);
  });

  test("with Sam back, the same order fits after the material lands", async () => {
    const qty = 30;
    const ready = material(qty);
    const built = buildScheduleRequest(shop(false), START, {
      includeParts: ["p1"],
    });
    const answer = await checkCapacity({
      ...built.request,
      time_limit_s: 6,
      new_order: {
        order_no: "NEW-1",
        part_no: built.partKeys.p1 ?? "BRK-2201",
        qty,
        due_date: iso(day(4)),
        priority: 0,
        release_date: ready?.date ?? null,
        release_note: ready?.note ?? null,
      },
    });
    expect(answer.can_take).toBe(true);
    // It can't start before the material: done on or after Thu Nov 12.
    expect(
      answer.new_order?.completion_date &&
        answer.new_order.completion_date >= iso(day(3))
    ).toBe(true);
    expect(answer.explanation).toContain("Material:");
  });
});
