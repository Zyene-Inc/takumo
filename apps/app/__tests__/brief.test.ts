// Morning brief (docs/PRODUCT-PLAN.md F4.1): content by role, empty
// sections dropped, timing, and what the plan says is late and why.
import type {
  ScheduleRequest,
  ScheduleResponse,
} from "@repo/engine-client/types";
import { describe, expect, test } from "vitest";
import {
  assembleBrief,
  briefSubject,
  type ShopBrief,
  sectionsFor,
} from "../lib/brief/content";
import {
  bottleneckOn,
  lateOrders,
  materialShortThisWeek,
} from "../lib/brief/plan-view";
import { briefDue, DEFAULT_TIMING, localNow } from "../lib/brief/timing";

const empty: ShopBrief = {
  late: [],
  atRisk: [],
  bottleneck: null,
  drafts: [],
  noDraft: [],
  unanswered: [],
  facts: { count: 0, top: [] },
  material: [],
  planDay: null,
  sync: [],
};

const full: ShopBrief = {
  ...empty,
  late: [
    {
      orderNo: "SO-1",
      customer: "Acme",
      daysLate: 3,
      due: "2026-11-10",
      completion: "2026-11-13",
      cause: "machine",
      causeText: "HAAS-VF2 is fully booked",
      lever: "Overtime on HAAS-VF2, or split the lot",
    },
  ],
  bottleneck: {
    machine: "HAAS-VF2",
    date: "2026-11-09",
    loadMinutes: 450,
    capacityMinutes: 480,
  },
  drafts: [{ rfqId: "r1", label: "RFQ-0012", customer: "Acme", hours: 30 }],
  unanswered: [
    {
      rfqId: "r2",
      lineId: "l2",
      quoteNo: "Q-9008",
      customer: "Beta",
      days: 12,
    },
  ],
  facts: {
    count: 5,
    top: [
      { id: "f1", text: "F-1: a" },
      { id: "f2", text: "F-2: b" },
      { id: "f3", text: "F-3: c" },
    ],
  },
  material: [
    {
      orderNo: "SO-4",
      starts: "2026-11-11",
      ready: "2026-11-12",
      note: "on PO-55, due Thu Nov 12",
      notOrdered: false,
    },
  ],
  sync: ["• Open orders: last arrived 3 days ago."],
};

describe("brief content", () => {
  test("sections by role", () => {
    expect(sectionsFor("admin")).toHaveLength(6);
    expect(sectionsFor("owner")).toContain("sync");
    expect(sectionsFor("planner")).toEqual([
      "late",
      "bottleneck",
      "facts",
      "material",
    ]);
    expect(sectionsFor("estimator")).toEqual(["quotes"]);
    expect(sectionsFor("operator")).toEqual([]);
    expect(sectionsFor(null)).toEqual([]);
  });

  test("nothing in it: no sections, so nothing is sent", () => {
    expect(assembleBrief("admin", [], empty)).toEqual([]);
  });

  test("only sections with something in them, in order", () => {
    const sections = assembleBrief("admin", [], {
      ...full,
      bottleneck: null,
      sync: [],
    });
    expect(sections.map((s) => s.key)).toEqual([
      "late",
      "quotes",
      "facts",
      "material",
    ]);
  });

  test("sections turned off are left out", () => {
    const sections = assembleBrief("planner", ["facts", "late"], full);
    expect(sections.map((s) => s.key)).toEqual(["bottleneck", "material"]);
  });

  test("a planner never sees quotes or sync, an estimator only quotes", () => {
    expect(assembleBrief("planner", [], full).map((s) => s.key)).not.toContain(
      "quotes"
    );
    expect(assembleBrief("estimator", [], full).map((s) => s.key)).toEqual([
      "quotes",
    ]);
  });

  test("late lines give the cause and the lever, and link to a screen", () => {
    const [late] = assembleBrief("planner", [], full);
    expect(late.lines[0].text).toBe(
      "SO-1 (Acme): 3 days late, due Tue Nov 10. HAAS-VF2 is fully booked. Best lever: Overtime on HAAS-VF2, or split the lot."
    );
    expect(late.lines[0].path).toBe("/schedule/bottlenecks");
  });

  test("facts: the count, the top 3, approve and reject buttons", () => {
    const facts = assembleBrief("planner", [], full).find(
      (s) => s.key === "facts"
    );
    expect(facts?.summary).toBe("5 facts waiting. The first 3 below.");
    expect(facts?.lines).toHaveLength(3);
    expect(facts?.lines[0].buttons?.map((b) => b.action)).toEqual([
      { kind: "fact", factId: "f1", decision: "approve" },
      { kind: "fact", factId: "f1", decision: "reject" },
    ]);
  });

  test("quotes: waiting drafts, and won / lost buttons for sent ones", () => {
    const quotes = assembleBrief("estimator", [], full)[0];
    expect(quotes.lines.map((l) => l.text)).toEqual([
      "RFQ-0012 (Acme): draft ready 30 hours ago, not sent.",
      "Q-9008 (Beta): sent 12 days ago, no answer yet.",
    ]);
    expect(quotes.lines[1].buttons?.map((b) => b.label)).toEqual([
      "Won",
      "Lost",
    ]);
    expect(quotes.lines[0].path).toBe("/quotes/r1");
  });

  test("sync lines drop the bullet", () => {
    const sync = assembleBrief("admin", [], full).find((s) => s.key === "sync");
    expect(sync?.lines[0].text).toBe("Open orders: last arrived 3 days ago.");
  });

  test("subject names what needs them", () => {
    expect(briefSubject(assembleBrief("admin", [], full), "2026-11-10")).toBe(
      "Morning brief, Tue Nov 10: orders at risk, quotes waiting, facts to approve"
    );
  });
});

describe("brief timing", () => {
  // 2026-11-10 is a Tuesday; 12:30 UTC is 06:30 in Chicago (CST, UTC-6).
  const at = (iso: string) => new Date(iso);

  test("local time in the person's zone", () => {
    expect(localNow("America/Chicago", at("2026-11-10T12:30:00Z"))).toEqual({
      date: "2026-11-10",
      minutes: 6 * 60 + 30,
      weekday: 2,
    });
  });

  test("due from their time for two hours, once a day", () => {
    expect(briefDue(DEFAULT_TIMING, at("2026-11-10T12:29:00Z")).due).toBe(
      false
    );
    expect(briefDue(DEFAULT_TIMING, at("2026-11-10T12:30:00Z")).due).toBe(true);
    expect(briefDue(DEFAULT_TIMING, at("2026-11-10T14:29:00Z")).due).toBe(true);
    expect(briefDue(DEFAULT_TIMING, at("2026-11-10T14:30:00Z")).due).toBe(
      false
    );
    expect(
      briefDue(
        { ...DEFAULT_TIMING, lastBriefOn: "2026-11-10" },
        at("2026-11-10T13:00:00Z")
      ).due
    ).toBe(false);
  });

  test("weekdays only", () => {
    // Saturday Nov 14, 06:45 Chicago.
    expect(briefDue(DEFAULT_TIMING, at("2026-11-14T12:45:00Z")).due).toBe(
      false
    );
  });

  test("their own time and zone; off means never", () => {
    const berlin = {
      ...DEFAULT_TIMING,
      timeZone: "Europe/Berlin",
      briefTime: "07:15",
    };
    // 06:15 UTC is 07:15 in Berlin (CET).
    expect(briefDue(berlin, at("2026-11-10T06:15:00Z"))).toEqual({
      due: true,
      date: "2026-11-10",
    });
    expect(
      briefDue({ ...berlin, briefOn: false }, at("2026-11-10T06:15:00Z")).due
    ).toBe(false);
  });

  test("a bad zone falls back to the default", () => {
    expect(
      briefDue(
        { ...DEFAULT_TIMING, timeZone: "Mars/Olympus" },
        at("2026-11-10T12:30:00Z")
      ).due
    ).toBe(true);
  });
});

const request: ScheduleRequest = {
  start_date: "2026-11-09",
  work_centers: [{ name: "HAAS-VF2", hours_per_day: 8 }],
  parts: [
    {
      part_no: "P-1",
      routing: [
        {
          seq: 10,
          work_center: "HAAS-VF2",
          setup_min: 30,
          run_min_per_unit: 2,
          alt_work_centers: ["OKUMA"],
        },
      ],
    },
    {
      part_no: "P-2",
      routing: [
        { seq: 10, work_center: "MAZAK", setup_min: 30, run_min_per_unit: 2 },
      ],
    },
  ],
  orders: [
    { order_no: "SO-1", part_no: "P-1", qty: 10, due_date: "2026-11-10" },
    {
      order_no: "SO-2",
      part_no: "P-2",
      qty: 10,
      due_date: "2026-11-12",
      release_date: "2026-11-12",
      release_note: "on PO-55, due Thu Nov 12",
    },
    { order_no: "SO-3", part_no: "P-2", qty: 10, due_date: "2026-11-11" },
    { order_no: "SO-4", part_no: "P-2", qty: 10, due_date: "2026-11-30" },
  ],
};

const op = (order: string, wc: string, start: string, end: string) => ({
  order_no: order,
  seq: 10,
  work_center: wc,
  start_at: `${start}T07:00:00`,
  end_at: `${end}T15:00:00`,
  start_date: start,
  end_date: end,
  minutes: 60,
  pinned: false,
});

const output: ScheduleResponse = {
  status: "OPTIMAL",
  total_days_late: 5,
  conflicts: [],
  operations: [
    op("SO-1", "HAAS-VF2", "2026-11-11", "2026-11-13"),
    op("SO-2", "MAZAK", "2026-11-12", "2026-11-14"),
    op("SO-3", "MAZAK", "2026-11-09", "2026-11-11"),
    op("SO-4", "MAZAK", "2026-11-10", "2026-11-10"),
  ],
  orders: [
    {
      order_no: "SO-1",
      due_date: "2026-11-10",
      completion_date: "2026-11-13",
      days_late: 3,
    },
    {
      order_no: "SO-2",
      due_date: "2026-11-12",
      completion_date: "2026-11-14",
      days_late: 2,
    },
    {
      order_no: "SO-3",
      due_date: "2026-11-11",
      completion_date: "2026-11-11",
      days_late: 0,
    },
    {
      order_no: "SO-4",
      due_date: "2026-11-30",
      completion_date: "2026-11-10",
      days_late: 0,
    },
  ],
  load: [
    {
      work_center: "HAAS-VF2",
      date: "2026-11-09",
      load_minutes: 300,
      capacity_minutes: 480,
    },
    {
      work_center: "MAZAK",
      date: "2026-11-09",
      load_minutes: 420,
      capacity_minutes: 420,
      machine_minutes: 480,
    },
  ],
};

describe("what the plan says", () => {
  const plan = { request, output };

  test("late and at risk, with cause and lever", () => {
    const { late, atRisk } = lateOrders(plan, new Map([["SO-1", "Acme"]]));
    expect(late.map((o) => o.orderNo)).toEqual(["SO-1", "SO-2"]);
    expect(late[0]).toMatchObject({
      customer: "Acme",
      daysLate: 3,
      cause: "machine",
      causeText: "HAAS-VF2 is fully booked",
      lever: "Move op 10 to OKUMA",
    });
    expect(late[1]).toMatchObject({
      cause: "material",
      causeText: "Waiting for material (on PO-55, due Thu Nov 12)",
    });
    // Finishes on its due date, short of people on its machine.
    expect(atRisk).toHaveLength(1);
    expect(atRisk[0]).toMatchObject({
      orderNo: "SO-3",
      cause: "people",
      causeText: "Not enough people on MAZAK",
    });
  });

  test("the bottleneck is the fullest machine today", () => {
    expect(bottleneckOn(output, "2026-11-09")).toEqual({
      machine: "MAZAK",
      date: "2026-11-09",
      loadMinutes: 420,
      capacityMinutes: 420,
    });
    expect(bottleneckOn(output, "2026-11-20")).toBeNull();
  });

  test("material short: orders starting this week without it", () => {
    const material = new Map([
      [
        "SO-2",
        {
          date: "2026-11-12",
          note: "on PO-55, due Thu Nov 12",
          notOrdered: false,
          unknown: false,
        },
      ],
      [
        "SO-4",
        {
          date: null,
          note: "4 ft on hand",
          notOrdered: false,
          unknown: false,
        },
      ],
      [
        "SO-3",
        {
          date: "2026-11-16",
          note: "not ordered",
          notOrdered: true,
          unknown: false,
        },
      ],
    ]);
    expect(
      materialShortThisWeek(output, material, "2026-11-09").map((m) => [
        m.orderNo,
        m.ready,
      ])
    ).toEqual([
      ["SO-3", null],
      ["SO-2", "2026-11-12"],
    ]);
  });
});
