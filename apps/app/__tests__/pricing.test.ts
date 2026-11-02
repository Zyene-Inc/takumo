import type { QuoteBreak, QuoteResponse } from "@repo/engine-client/types";
import { describe, expect, test } from "vitest";
import {
  applyMarginFloor,
  buildUp,
  densityFor,
  drawingSummary,
  envelopeText,
  explainMaterialLine,
  groupByWait,
  latestPoPrice,
  materialPricing,
  materialWait,
  mergeResponses,
  normalizeUnit,
  operationBasis,
  outsideDays,
  outsideProcesses,
  type PlannedOperation,
  type PoLine,
  parseStockSize,
  readDrawing,
  stockUsage,
  supplierFor,
  withOutsideDays,
} from "../lib/quotes/pricing";
import { applyProposal, type CandidatePart } from "../lib/quotes/routing";
import type { DrawingReading, OutsideSupplier } from "../lib/quotes/types";

const po = (over: Partial<PoLine>): PoLine => ({
  poNo: "4500",
  lineNo: 1,
  supplier: "Metals Co",
  qtyOrdered: 100,
  qtyReceived: 0,
  unit: "lb",
  unitPrice: 3,
  orderedAt: "2026-09-01",
  dueDate: "2026-11-20",
  status: "open",
  ...over,
});

const ALUMINUM = { name: "AL 6061-T6", unit: "lb", unitCost: 2.5 };

describe("stock size and usage", () => {
  test("reads round bar, plate, tube and metric sizes in inches", () => {
    expect(parseStockSize('1.25" DIA x 4.0', "bar", "in")).toEqual({
      diameter: 1.25,
      length: 4,
    });
    expect(parseStockSize("3/4 x 3 x 6", "plate", null)).toEqual({
      thickness: 0.75,
      width: 3,
      length: 6,
    });
    expect(parseStockSize("2 OD x .125 wall x 6", "tube", null)).toEqual({
      diameter: 2,
      inner: 1.75,
      length: 6,
    });
    const mm = parseStockSize("Ø25.4 x 101.6", "bar", "mm");
    expect(mm?.diameter).toBeCloseTo(1);
    expect(mm?.length).toBeCloseTo(4);
    expect(parseStockSize("1-1/4 RD x 4", "bar", null)?.diameter).toBe(1.25);
    expect(parseStockSize("bar stock", "bar", null)).toBeNull();
  });

  test("pounds from volume and the material's density", () => {
    const u = stockUsage({
      materialName: "AL 6061-T6",
      stock: { form: "bar", size: "2 DIA x 5" },
      unit: "LBS",
      units: "in",
    });
    // π/4 × 4 × 5 = 15.708 in³ × 0.098 = 1.539 lb
    expect(u?.usage).toBeCloseTo(1.539, 3);
    expect(u?.basis).toContain("aluminum");
  });

  test("feet of bar, square feet of plate, one blank", () => {
    expect(
      stockUsage({
        materialName: "1018",
        stock: { form: "bar", size: "1 DIA x 6" },
        unit: "ft",
        units: "in",
      })?.usage
    ).toBe(0.5);
    expect(
      stockUsage({
        materialName: "6061",
        stock: { form: "plate", size: "0.5 x 6 x 12" },
        unit: "sq ft",
        units: "in",
      })?.usage
    ).toBe(0.5);
    expect(
      stockUsage({
        materialName: "x",
        stock: { form: "other", size: "blank" },
        unit: "ea",
        units: null,
      })?.usage
    ).toBe(1);
  });

  test("no usage when the unit or density isn't known", () => {
    expect(
      stockUsage({
        materialName: "Unobtainium",
        stock: { form: "bar", size: "1 DIA x 6" },
        unit: "lb",
        units: "in",
      })
    ).toBeNull();
    expect(
      stockUsage({
        materialName: "6061",
        stock: { form: "plate", size: "0.5 x 6 x 12" },
        unit: "ft",
        units: "in",
      })
    ).toBeNull();
    expect(normalizeUnit("sheet")).toBeNull();
  });

  test("stainless is not taken for plain steel", () => {
    expect(densityFor("304 Stainless")?.family).toBe("stainless steel");
    expect(densityFor("4140 steel")?.family).toBe("steel");
    expect(densityFor("7075-T651")?.lbPerIn3).toBe(0.101);
  });
});

describe("material price", () => {
  test("the newest PO price in the material's unit wins", () => {
    const price = latestPoPrice(
      [
        po({ poNo: "A", orderedAt: "2026-08-01", unitPrice: 2 }),
        po({ poNo: "B", orderedAt: "2026-10-01", unitPrice: 3.2 }),
        po({ poNo: "C", orderedAt: "2026-10-15", unitPrice: 9, unit: "ft" }),
        po({ poNo: "D", orderedAt: "2026-10-20", status: "cancelled" }),
        po({ poNo: "E", orderedAt: "2026-10-30", unitPrice: null }),
      ],
      "lb"
    );
    expect(price).toMatchObject({
      poNo: "B",
      unitPrice: 3.2,
      date: "2026-10-01",
    });
  });

  test("drawing stock × latest PO price, plus markup", () => {
    const m = materialPricing({
      estimatorCost: null,
      usagePerPart: null,
      stock: { form: "bar", size: "2 DIA x 5" },
      drawingUnits: "in",
      markup: 0.2,
      materialText: null,
      material: ALUMINUM,
      poPrice: latestPoPrice([po({ poNo: "4512", unitPrice: 3 })], "lb"),
    });
    expect(m?.source).toMatchObject({ kind: "po", ref: "4512" });
    expect(m?.costPerPart).toBeCloseTo(1.539 * 3, 3);
    expect(m?.perPart).toBeCloseTo(1.539 * 3 * 1.2, 3);
    expect(m?.basis).toContain("PO 4512");
    expect(m?.basis).toContain("20% material markup");
  });

  test("falls back to the material's unit cost without a PO price", () => {
    const m = materialPricing({
      estimatorCost: null,
      usagePerPart: 2,
      stock: null,
      drawingUnits: null,
      markup: 0,
      materialText: null,
      material: ALUMINUM,
      poPrice: null,
    });
    expect(m).toMatchObject({ perPart: 5, source: { kind: "material" } });
  });

  test("the estimator's cost per part is used as entered, with markup", () => {
    const m = materialPricing({
      estimatorCost: 10,
      usagePerPart: null,
      stock: null,
      drawingUnits: null,
      markup: 0.1,
      materialText: null,
      material: null,
      poPrice: null,
    });
    expect(m).toMatchObject({ perPart: 11, source: { kind: "estimator" } });
  });

  test("nothing to go on: the engine's history decides", () => {
    expect(
      materialPricing({
        estimatorCost: null,
        usagePerPart: null,
        stock: null,
        drawingUnits: null,
        markup: 0.15,
        materialText: null,
        material: ALUMINUM,
        poPrice: null,
      })
    ).toBeNull();
  });
});

describe("when the material is in the shop", () => {
  const base = {
    qty: 100,
    today: "2026-11-02",
    materialName: "AL 6061-T6",
    unit: "lb",
    usagePerPart: 2,
    leadTimeDays: 21,
  };

  test("free stock covers it: no wait", () => {
    expect(
      materialWait({ ...base, available: 250, openPos: [] })
    ).toMatchObject({ days: 0, source: { kind: "stock" } });
  });

  test("the open PO that brings enough sets the wait", () => {
    const wait = materialWait({
      ...base,
      available: 50,
      openPos: [
        po({ poNo: "LATE", dueDate: "2026-12-01", qtyOrdered: 500 }),
        po({ poNo: "SOON", dueDate: "2026-11-09", qtyOrdered: 100 }),
        po({ poNo: "NEXT", dueDate: "2026-11-16", qtyOrdered: 100 }),
      ],
    });
    // 50 + 100 (Nov 9) = 150 < 200; + 100 (Nov 16) = 250 ≥ 200
    expect(wait).toMatchObject({
      days: 14,
      source: { kind: "po", ref: "NEXT" },
    });
  });

  test("not enough coming: the material's lead time", () => {
    expect(
      materialWait({ ...base, available: 0, openPos: [po({ qtyOrdered: 10 })] })
    ).toMatchObject({ days: 21, source: { kind: "lead_time" } });
  });

  test("usage unknown: only the lead time can be used", () => {
    expect(
      materialWait({ ...base, usagePerPart: null, available: 1e6, openPos: [] })
    ).toMatchObject({ days: 21 });
  });

  test("quantities with the same wait share one engine call", () => {
    const groups = groupByWait(
      [10, 50, 500],
      new Map([
        [10, 0],
        [50, 0],
        [500, 14],
      ])
    );
    expect(groups.map((g) => [g.days, g.qtys])).toEqual([
      [0, [10, 50]],
      [14, [500]],
    ]);
    expect(groupByWait([1, 2])).toEqual([
      { days: null, qtys: [1, 2], keep: true },
    ]);
  });
});

const finish = (value: string, kind: "anodize" | "heat_treat" = "anodize") =>
  ({
    value,
    text: value,
    kind,
    spec: null,
    confidence: "high",
    sheet: 1,
    box: null,
  }) as DrawingReading["finishes"][number];

const SUPPLIERS: OutsideSupplier[] = [
  {
    process: "Anodize type II",
    supplier: "Bright Finishing",
    leadTimeDays: 5,
    costPerPart: 1.5,
    lotCharge: 75,
  },
];

describe("outside processes", () => {
  test("a drawing finish is priced from the shop's supplier", () => {
    const plan = outsideProcesses({
      drawingFinishes: [finish("ANODIZE BLACK PER MIL-A-8625")],
      lineFinish: null,
      saved: null,
      suppliers: SUPPLIERS,
    });
    expect(plan.outside[0]).toEqual({
      description: "ANODIZE BLACK PER MIL-A-8625",
      cost_per_unit: 1.5,
      cost_per_lot: 75,
    });
    expect(plan.meta[0]).toMatchObject({
      supplier: "Bright Finishing",
      leadTimeDays: 5,
      askSupplier: false,
    });
  });

  test("an unknown process is kept, to ask the supplier", () => {
    const plan = outsideProcesses({
      drawingFinishes: [finish("HEAT TREAT TO RC 40-44", "heat_treat")],
      lineFinish: null,
      saved: null,
      suppliers: SUPPLIERS,
    });
    expect(plan.outside[0].cost_per_unit).toBeNull();
    expect(plan.meta[0]).toMatchObject({
      askSupplier: true,
      source: { kind: "default" },
    });
  });

  test("the estimator's outside processes are kept as they are", () => {
    const plan = outsideProcesses({
      drawingFinishes: [finish("anodize")],
      lineFinish: "anodize",
      saved: [{ description: "Clear anodize", cost_per_lot: 120 }],
      suppliers: SUPPLIERS,
    });
    expect(plan.outside).toEqual([
      { description: "Clear anodize", cost_per_lot: 120 },
    ]);
    expect(plan.meta[0].source.kind).toBe("estimator");
    expect(plan.meta[0].leadTimeDays).toBe(5);
  });

  test("suppliers match by kind when the words differ", () => {
    expect(supplierFor("Hard coat anodise", SUPPLIERS)?.supplier).toBe(
      "Bright Finishing"
    );
    expect(supplierFor("Zinc plate", SUPPLIERS)).toBeNull();
  });

  test("outside days run one after another and push the finish date", () => {
    expect(
      outsideDays([
        { leadTimeDays: 5 },
        { leadTimeDays: 7 },
        { leadTimeDays: null },
      ] as never)
    ).toBe(12);
    const row = withOutsideDays(
      breakRow({ lead_time_days: 10, completion_date: "2026-11-12" }),
      5,
      "2026-11-15"
    );
    expect(row).toMatchObject({
      lead_time_days: 15,
      completion_date: "2026-11-17",
      meets_requested: false,
    });
  });
});

function breakRow(over: Partial<QuoteBreak> = {}): QuoteBreak {
  return {
    qty: 100,
    lines: [],
    cost: 1000,
    unit_cost: 10,
    unit_price: 12.5,
    price: 1250,
    price_low: 1200,
    price_high: 1300,
    margin_pct: 0.2,
    lead_time_days: 10,
    completion_date: "2026-11-12",
    meets_requested: null,
    ...over,
  };
}

describe("margin floor", () => {
  test("raises a price below the customer's floor", () => {
    const { row, raised } = applyMarginFloor(breakRow(), 0.3);
    expect(raised).toBe(true);
    // 1000 / 0.7 / 100 = 14.2857 → 14.29
    expect(row).toMatchObject({ unit_price: 14.29, price: 1429 });
    expect(row.margin_pct).toBeCloseTo(0.3002, 3);
    expect(row.price_low).toBe(1429);
  });

  test("leaves prices at or above the floor alone", () => {
    expect(applyMarginFloor(breakRow(), 0.2).raised).toBe(false);
    expect(applyMarginFloor(breakRow(), null).raised).toBe(false);
    expect(applyMarginFloor(breakRow({ cost: null }), 0.5).raised).toBe(false);
  });
});

describe("operations and their basis", () => {
  const candidates: CandidatePart[] = [
    {
      id: "p1",
      partNo: "P-2001",
      rev: "A",
      description: "bracket",
      material: "6061",
      customer: null,
      routing: [
        {
          seq: 10,
          work_center: "HAAS-VF2",
          setup_min: 45,
          run_min_per_unit: 6,
        },
      ],
    },
  ];

  test("a proposal keeps its reason, alternates and similar part", () => {
    const { ops } = applyProposal(
      [
        {
          workCenter: "HAAS-VF2",
          alternates: ["HAAS-VF4", "LASER-9", "HAAS-VF2"],
          basisPartNo: "P-2001",
          basisSeq: 10,
          setupScale: 1,
          runScale: 1.5,
          setupMin: null,
          runMinPerUnit: null,
          reason:
            "3 threaded holes and a pocket → mill op on HAAS-VF2, like P-2001",
        },
        {
          workCenter: "DEBURR-1",
          basisPartNo: null,
          basisSeq: null,
          setupScale: null,
          runScale: null,
          setupMin: 5,
          runMinPerUnit: 1,
          reason: "break edges",
        },
      ],
      candidates,
      ["HAAS-VF2", "HAAS-VF4", "DEBURR-1"]
    );
    expect(ops[0]).toMatchObject({
      alt_work_centers: ["HAAS-VF4"],
      basis_part_no: "P-2001",
      is_default: false,
      run_min_per_unit: 9,
    });
    expect(ops[0].note).toContain("like P-2001 op 10 (45 min + 6 min/ea)");
    expect(ops[1].is_default).toBe(true);
    const ctx = { erpSynced: false, facts: new Map(), partNo: "NEW-1" };
    expect(operationBasis(ops[0], ctx)).toEqual({
      basis: { kind: "similar_part", label: "Like P-2001", ref: "P-2001" },
      isDefault: false,
    });
    expect(operationBasis(ops[1], ctx).isDefault).toBe(true);
    expect(operationBasis(ops[1], ctx).basis.kind).toBe("default");
  });

  test("an existing part: approved fact, ERP routing, shop routing, actuals", () => {
    const op = (over: Partial<PlannedOperation>): PlannedOperation => ({
      seq: 10,
      work_center: "HAAS-VF2",
      setup_min: 30,
      run_min_per_unit: 4,
      source: "routing",
      ...over,
    });
    const facts = new Map([[10, { number: 12, date: "2026-10-01" }]]);
    expect(
      operationBasis(op({}), { erpSynced: true, facts, partNo: "P-1" }).basis
    ).toMatchObject({ kind: "fact", label: "Approved fact F-12" });
    expect(
      operationBasis(op({ seq: 20 }), { erpSynced: true, facts, partNo: "P-1" })
        .basis.kind
    ).toBe("erp");
    expect(
      operationBasis(op({}), {
        erpSynced: false,
        facts: new Map(),
        partNo: "P-1",
      }).basis.kind
    ).toBe("routing");
    expect(
      operationBasis(op({ source: "actuals", note: "median of 3 jobs" }), {
        erpSynced: false,
        facts: new Map(),
        partNo: "P-1",
      }).basis.label
    ).toContain("median of 3 jobs");
    // Saved before Phase 2 (no is_default field): read from the note.
    expect(
      operationBasis(
        op({
          source: "comparable",
          note: "no similar operation in the shop, Takumo's estimate: x",
        }),
        { erpSynced: false, facts: new Map(), partNo: "P-1" }
      ).isDefault
    ).toBe(true);
  });
});

const response = (breaks: QuoteBreak[]): QuoteResponse => ({
  status: "OPTIMAL",
  breaks,
  checks: [],
  comparables: [],
  lead_time_note: null,
  margin: {
    target: 0.25,
    low: 0.2,
    high: 0.32,
    basis: "Median actual margin on the shop's 4 won quotes",
    sources: ["quote Q-1"],
  },
  missing: [],
  warnings: [],
});

describe("price build-up", () => {
  test("every component per quantity, with setup spread over the parts", () => {
    const routing: PlannedOperation[] = [
      {
        seq: 10,
        work_center: "HAAS-VF2",
        setup_min: 60,
        run_min_per_unit: 5,
        source: "routing",
      },
      {
        seq: 20,
        work_center: "DEBURR-1",
        setup_min: 10,
        run_min_per_unit: 1,
        source: "comparable",
        is_default: true,
        note: "no similar operation in the shop, Takumo's estimate: x",
      },
    ];
    const rows = [10, 100].map((qty) =>
      breakRow({
        qty,
        lines: [
          {
            kind: "machine",
            label: "Op 10 · HAAS-VF2",
            amount: 50,
            basis: "",
            sources: [],
          },
          {
            kind: "machine",
            label: "Op 20 · DEBURR-1",
            amount: 9,
            basis: "",
            sources: [],
          },
          {
            kind: "material",
            label: "Material",
            amount: 30,
            basis: "as stated",
            sources: [],
          },
          {
            kind: "outside",
            label: "Anodize",
            amount: 90,
            basis: "",
            sources: [],
          },
        ],
      })
    );
    const material = materialPricing({
      estimatorCost: null,
      usagePerPart: 1,
      stock: null,
      drawingUnits: null,
      markup: 0,
      materialText: null,
      material: ALUMINUM,
      poPrice: null,
    });
    const result = buildUp(response(rows), {
      routing,
      material,
      materialWaits: new Map([
        [10, { days: 0, source: { kind: "stock", label: "In stock" } }],
      ]),
      outside: [
        {
          process: "Anodize",
          supplier: "Bright",
          cost: null,
          leadTimeDays: 5,
          askSupplier: false,
          source: { kind: "supplier", label: "Bright" },
        },
      ],
      outsideDays: 5,
      floor: 0.3,
      floorRaised: new Set([100]),
      laborRate: { rate: 95, set: false },
      machines: new Map([
        ["HAAS-VF2", { rate: 120, efficiency: 1 }],
        ["DEBURR-1", { rate: null, efficiency: 0.5 }],
      ]),
      opBasis: new Map(
        routing.map((op) => [
          op.seq,
          operationBasis(op, {
            erpSynced: false,
            facts: new Map(),
            partNo: "P",
          }),
        ])
      ),
    });
    expect(result.map((b) => b.qty)).toEqual([10, 100]);
    const [ten, hundred] = result;
    expect(ten.operations[0]).toMatchObject({
      setupPerPart: 6,
      rate: 120,
      cost: 50,
      rateSource: { kind: "rate" },
    });
    expect(hundred.operations[0].setupPerPart).toBe(0.6);
    // No machine rate: the shop rate, flagged as a default until it's set.
    expect(ten.operations[1]).toMatchObject({
      rate: 95,
      isDefault: true,
      rateSource: { kind: "default" },
    });
    // 10 + 1 × 10 = 20 min at 50% efficiency = 40 min
    expect(ten.operations[1].hours).toBeCloseTo(0.67, 2);
    expect(ten.material).toMatchObject({ cost: 30, perPart: 2.5 });
    expect(ten.outside[0]).toMatchObject({ cost: 90, supplier: "Bright" });
    expect(ten.margin.raisedByFloor).toBe(false);
    expect(hundred.margin).toMatchObject({
      raisedByFloor: true,
      floor: 0.3,
      source: { kind: "floor" },
    });
    expect(ten.lead).toMatchObject({
      leadTimeDays: 5,
      outsideDays: 5,
      materialWaitDays: 0,
    });
    expect(hundred.lead.materialSource.kind).toBe("default");
  });

  test("engine calls per wait merge into one answer, quantities in order", () => {
    const a = response([breakRow({ qty: 500 })]);
    const b = {
      ...response([breakRow({ qty: 10 }), breakRow({ qty: 50 })]),
      warnings: ["w"],
    };
    const merged = mergeResponses([a, b]);
    expect(merged.breaks.map((r) => r.qty)).toEqual([10, 50, 500]);
    expect(merged.warnings).toEqual(["w"]);
  });

  test("the material line says where its price came from", () => {
    const material = materialPricing({
      estimatorCost: null,
      usagePerPart: 2,
      stock: null,
      drawingUnits: null,
      markup: 0,
      materialText: null,
      material: ALUMINUM,
      poPrice: latestPoPrice([po({ poNo: "4512" })], "lb"),
    });
    const [line] = explainMaterialLine(
      [
        {
          kind: "material",
          label: "Material",
          amount: 6,
          basis: "as stated",
          sources: [],
        },
      ],
      material
    );
    expect(line.basis).toContain("PO 4512");
    expect(line.sources).toEqual(["po 4512"]);
  });
});

describe("drawing in words", () => {
  test("tolerates partial readings and summarises the useful parts", () => {
    const d = readDrawing({
      units: "in",
      stock: { form: "bar", size: "1.5 DIA x 3" },
      features: [
        {
          kind: "thread",
          count: 3,
          detail: "1/4-20 UNC x .5 deep",
          text: "3X 1/4-20",
          value: "",
          confidence: "high",
          sheet: 1,
          box: null,
        },
      ],
      tolerances: [
        {
          text: "±.0005",
          tolerance: 0.0005,
          kind: "dimension",
          datums: [],
          symbol: null,
          value: "",
          confidence: "high",
          sheet: 1,
          box: null,
        },
      ],
    });
    expect(d?.finishes).toEqual([]);
    const text = drawingSummary(d);
    expect(text).toContain("Stock: 1.5 DIA x 3 bar");
    expect(text).toContain("3 × thread");
    expect(text).toContain("±.0005");
    expect(readDrawing(null)).toBeNull();
    expect(drawingSummary(null)).toBeNull();
  });

  test("machine envelopes in words", () => {
    expect(envelopeText({ x: 30, y: 16, z: 20 })).toBe("30 × 16 × 20 in");
    expect(envelopeText({ diameter: 10, length: 20 })).toBe("Ø10 × 20 in");
    expect(envelopeText(null)).toBeNull();
  });
});
