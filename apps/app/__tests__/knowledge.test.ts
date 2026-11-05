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
import { type BrainRows, buildBrain } from "../lib/knowledge/brain";
import {
  chunkPages,
  htmlTablesToMarkdown,
  TABLE_CHARS,
} from "../lib/knowledge/chunk";
import {
  type CatalogEntry,
  normalize,
  resolveMention,
} from "../lib/knowledge/resolve";
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
  const shop = (
    doneSeqs: number[],
    progress?: Record<number, number>
  ): ShopRows => ({
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
        progress,
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

  test("parts already through a step: no setup, only the rest run", () => {
    const { request } = buildScheduleRequest(shop([], { 10: 4 }), "2026-11-02");
    const key = "P-1 (op 10: 4 through)";
    expect(request.orders[0].part_no).toBe(key);
    const routing = request.parts.find((p) => p.part_no === key)?.routing;
    expect(routing?.[0]).toMatchObject({
      seq: 10,
      setup_min: 0,
      // 6 of 10 parts left at 2 min each: 1.2 min per ordered part.
      run_min_per_unit: 1.2,
    });
    expect(routing?.[1]).toMatchObject({ seq: 20, setup_min: 5 });
  });

  test("every part through a step: the step is done", () => {
    const { request } = buildScheduleRequest(
      shop([], { 10: 10 }),
      "2026-11-02"
    );
    expect(request.orders[0].part_no).toBe("P-1 after op 10");
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
    expect(
      checkLog(
        {
          ...log,
          startedAt: new Date("2026-11-02T11:30:00Z"),
          finishedAt: new Date("2026-11-02T11:00:00Z"),
        },
        now
      )
    ).toMatch(/start time is after/);
  });
});

describe("shop brain", () => {
  const rows: BrainRows = {
    shopName: "Acme Machining",
    customers: [{ id: "c1", name: "Boeing" }],
    materials: [{ id: "m1", name: "6061-T6", spec: "AMS 4027" }],
    workCenters: [{ id: "w1", name: "Haas VF-2", type: "cnc_mill" }],
    parts: [
      {
        id: "p1",
        partNo: "P-1001",
        rev: "A",
        description: "Bracket",
        customerId: "c1",
        materialId: "m1",
      },
      {
        id: "p2",
        partNo: "P-2001",
        rev: "C",
        description: null,
        customerId: null,
        materialId: null,
      },
    ],
    routings: [
      { id: "r1", partId: "p1", seq: 10, workCenterId: "w1" },
      { id: "r2", partId: "p1", seq: 20, workCenterId: "w1" },
    ],
    bom: [{ parentPartId: "p2", childPartId: "p1" }],
    orders: [
      {
        id: "o1",
        orderNo: "SO-1",
        customerId: "c1",
        partId: "p1",
        status: "in_progress",
      },
    ],
    quotes: [
      {
        id: "q1",
        quoteNo: "Q-1",
        customerId: "c1",
        partId: "p1",
        rfqId: "f1",
        status: "open",
      },
    ],
    rfqs: [
      {
        id: "f1",
        number: 7,
        subject: "Brackets",
        customerName: "Boeing",
        customerId: "c1",
      },
    ],
    facts: [
      {
        id: "x1",
        number: 12,
        subjectType: "routing",
        subjectId: "r1",
        subjectLabel: "P-1001 op 10",
        attribute: "setupMin",
        value: 120,
      },
      {
        id: "x2",
        number: 13,
        subjectType: "shop",
        subjectId: "org",
        subjectLabel: "Shop",
        attribute: "note",
        value: "Deburr everything by hand.",
      },
    ],
    documents: [
      { id: "d1", name: "Setup sheet P-1001.pdf", summary: "Haas VF-2 setup" },
    ],
  };
  const brain = buildBrain(rows);
  const node = (id: string) => brain.nodes.find((n) => n.id === id);
  const linked = (a: string, b: string) =>
    brain.links.some(
      (l) =>
        (l.source === a && l.target === b) || (l.source === b && l.target === a)
    );

  test("records become nodes that link to their pages", () => {
    expect(node("part:p1")?.href).toBe("/shop/parts/p1");
    expect(node("part:p2")?.label).toBe("P-2001 rev C");
    expect(node("rfq:f1")?.label).toBe("RFQ-0007");
    expect(node("quote:q1")?.href).toBe("/quotes/f1");
    expect(node("fact:x1")?.href).toBe("/knowledge/facts?f=F-12");
  });

  test("relationships become links, once each", () => {
    expect(linked("part:p1", "customer:c1")).toBe(true);
    expect(linked("part:p1", "material:m1")).toBe(true);
    expect(linked("part:p2", "part:p1")).toBe(true);
    expect(linked("order:o1", "part:p1")).toBe(true);
    expect(linked("quote:q1", "rfq:f1")).toBe(true);
    // Two operations on the same machine are one link, not two.
    expect(
      brain.links.filter(
        (l) => l.source === "part:p1" && l.target === "work_center:w1"
      )
    ).toHaveLength(1);
  });

  test("facts hang off what they describe", () => {
    expect(linked("fact:x1", "part:p1")).toBe(true);
    expect(node("shop")?.label).toBe("Acme Machining");
    expect(linked("fact:x2", "shop")).toBe(true);
    expect(node("fact:x2")?.sub).toBe("Deburr everything by hand.");
  });

  test("documents link to what they mention", () => {
    expect(linked("document:d1", "part:p1")).toBe(true);
    expect(linked("document:d1", "work_center:w1")).toBe(true);
    expect(linked("document:d1", "customer:c1")).toBe(false);
  });

  test("degree counts every link on a node", () => {
    const links = brain.links.filter(
      (l) => l.source === "part:p1" || l.target === "part:p1"
    ).length;
    expect(node("part:p1")?.degree).toBe(links);
  });

  test("links to missing records are dropped", () => {
    const orphan = buildBrain({
      ...rows,
      orders: [{ ...rows.orders[0], partId: "gone", customerId: null }],
    });
    expect(orphan.links.some((l) => l.source === "order:o1")).toBe(false);
  });
});

describe("document understanding", () => {
  const catalog: CatalogEntry[] = [
    {
      id: "p1",
      label: "P-2001 rev B",
      rev: "B",
      type: "part",
      keys: [normalize("P-2001")],
    },
    {
      id: "p2",
      label: "P-2001 rev C",
      rev: "C",
      type: "part",
      keys: [normalize("P-2001")],
    },
    {
      id: "m1",
      label: "HAAS-VF2",
      type: "machine",
      keys: [normalize("HAAS-VF2")],
    },
    {
      id: "m2",
      label: "HAAS-VF4",
      type: "machine",
      keys: [normalize("HAAS-VF4")],
    },
    {
      id: "m3",
      label: "OKUMA-LB3000",
      type: "machine",
      keys: [normalize("OKUMA-LB3000")],
    },
    {
      id: "c1",
      label: "Cobalt Medical",
      type: "customer",
      keys: [normalize("Cobalt Medical")],
    },
  ];
  const find = (name: string, type: CatalogEntry["type"]) =>
    resolveMention({ name, type }, catalog);

  test("names written differently match the shop's records", () => {
    expect(find("HAAS VF-2", "machine")).toMatchObject({
      id: "m1",
      how: "exact",
    });
    expect(find("P2001", "part")?.id).toBe("p1");
    expect(find("P2001 rev C", "part")).toMatchObject({
      id: "p2",
      label: "P-2001 rev C",
    });
    expect(find("the Okuma", "machine")).toMatchObject({
      id: "m3",
      how: "partial",
    });
    expect(find("VF2", "machine")?.id).toBe("m1");
    expect(find("COBALT MEDICAL INC.", "customer")?.id).toBe("c1");
  });

  test("ambiguous or unknown names stay unmatched instead of guessed", () => {
    expect(find("the Haas", "machine")).toBeNull();
    expect(find("Mazak", "machine")).toBeNull();
    expect(find("P-9999", "part")).toBeNull();
    expect(find("HAAS-VF2", "customer")).toBeNull();
  });

  test("scanned tables read as rows; long ones split between rows with the header repeated", () => {
    const html =
      "<table><tr><th>Op</th><th>Machine</th><th>Setup</th></tr><tr><td>20</td><td>HAAS <b>VF-2</b></td><td>45</td></tr></table>";
    expect(htmlTablesToMarkdown(`Ops:\n${html}`)).toBe(
      "Ops:\n| Op | Machine | Setup |\n| --- | --- | --- |\n| 20 | HAAS VF-2 | 45 |"
    );

    const small = chunkPages([
      { page: 1, text: `Setup\n\n${html}\n\nAfter the table.` },
    ]);
    expect(small.map((c) => c.content).join("\n")).toContain(
      "| 20 | HAAS VF-2 | 45 |"
    );

    const row = (i: number) =>
      `<tr><td>Op ${i}</td><td>${"x".repeat(150)}</td></tr>`;
    const big = `<table><tr><th>Op</th><th>Note</th></tr>${Array.from({ length: 40 }, (_, i) => row(i)).join("")}</table>`;
    const pieces = chunkPages([{ page: 1, text: big }]).map((c) => c.content);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.startsWith("| Op | Note |\n| --- | --- |\n")).toBe(true);
      expect(piece.length).toBeLessThanOrEqual(TABLE_CHARS);
      expect(
        piece
          .split("\n")
          .every((line) => line.startsWith("| ") && line.endsWith(" |"))
      ).toBe(true);
    }
    expect(pieces.join("\n")).toContain("| Op 39 |");
  });
});
