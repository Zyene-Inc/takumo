import { describe, expect, it } from "vitest";
import { scoreDrawing, summarizeDrawings } from "../evals/partners/drawings";
import {
  assignParts,
  type CheckContext,
  checkDrawing,
  linePatch,
  machineEnvelope,
  noDrawingReading,
  tightestTolerance,
} from "../lib/quotes/drawing-check";
import {
  cleanBox,
  cleanPart,
  mergeParts,
  type RawPart,
} from "../lib/quotes/drawing-schema";
import { mergeLines, splitLine } from "../lib/quotes/lines";
import type { DrawingReading, DrawingValue } from "../lib/quotes/types";

const v = <T = string>(
  text: string,
  value: T = text as T,
  confidence: DrawingValue["confidence"] = "high",
  sheet = 1
): DrawingValue<T> => ({
  text,
  value,
  confidence,
  sheet,
  box: [10, 10, 20, 20],
});

const reading = (over: Partial<DrawingReading> = {}): DrawingReading => ({
  fileId: "f1",
  fileName: "dwg.pdf",
  readAt: "2026-11-02T00:00:00Z",
  sheets: 1,
  units: "in",
  titleBlock: { partNo: v("1234-01"), rev: v("REV C", "C") },
  material: { ...v("AL 6061-T6"), grade: "6061", condition: "T6", spec: null },
  finishes: [],
  envelope: null,
  stock: null,
  features: [],
  tolerances: [],
  notes: [],
  requirements: [],
  quantities: [],
  flags: [],
  questions: [],
  ...over,
});

const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({
  certifications: [],
  line: null,
  machines: [],
  materialKnown: true,
  outsideProcesses: [],
  shopToleranceIn: 0.0005,
  ...over,
});

const tol = (
  text: string,
  tolerance: number,
  kind: "dimension" | "gdt" | "surface" = "dimension"
) => ({ ...v(text), kind, tolerance, symbol: null, datums: [] });

const kinds = (r: { flags: { kind: string }[] }) => r.flags.map((f) => f.kind);

describe("cleaning what the model read", () => {
  it("clamps, orders and rejects boxes", () => {
    expect(cleanBox([1200, -5, 100, 300])).toEqual([100, 0, 1000, 300]);
    expect(cleanBox([1, 2, 3])).toBeNull();
    expect(cleanBox([5, 5, 5, 9])).toBeNull();
    expect(cleanBox(null)).toBeNull();
    expect(cleanBox([0, 0, Number.NaN, 4])).toBeNull();
  });

  const raw = (over: Partial<RawPart> = {}): RawPart => ({
    partNo: {
      text: "P/N 1234-01",
      value: "1234-01",
      confidence: "high",
      sheet: 2,
      box: [0, 0, 10, 10],
    },
    rev: { text: "  ", value: null, confidence: "high", sheet: 1, box: null },
    title: null,
    drawingNo: null,
    scale: null,
    sheetOf: null,
    generalTolerance: null,
    drawnDate: null,
    approvedDate: null,
    material: null,
    finishes: [],
    envelope: {
      text: "4.00 x 2.00",
      confidence: "medium",
      sheet: 1,
      box: null,
      l: 4,
      w: 2,
      h: 0,
      diameter: null,
      length: -1,
    },
    stock: null,
    features: [
      {
        text: "4X Ø.250 THRU",
        confidence: "high",
        sheet: 9,
        box: null,
        kind: "hole",
        count: 0,
        detail: null,
      },
    ],
    tolerances: [],
    notes: [{ text: "", confidence: "high", sheet: 1, box: null }],
    requirements: [],
    quantities: [
      { text: "QTY 0", confidence: "high", sheet: 1, box: null, qty: 0 },
    ],
    ...over,
  });

  it("drops empty values, offsets and clamps sheets, keeps positive sizes", () => {
    const p = cleanPart(raw(), { sheets: 3, firstSheet: 2 });
    expect(p.titleBlock.partNo?.value).toBe("1234-01");
    expect(p.titleBlock.partNo?.sheet).toBe(3);
    expect(p.titleBlock.rev).toBeUndefined();
    expect(p.envelope?.value).toEqual({ l: 4, w: 2 });
    expect(p.features[0].sheet).toBe(3);
    expect(p.features[0].count).toBe(1);
    expect(p.notes).toEqual([]);
    expect(p.quantities).toEqual([]);
  });

  it("joins page groups of the same part and keeps the surer value", () => {
    const a = cleanPart(
      raw({
        material: {
          text: "6061",
          confidence: "low",
          sheet: 1,
          box: null,
          grade: null,
          condition: null,
          spec: null,
        },
      }),
      { sheets: 4, firstSheet: 1 }
    );
    const b = cleanPart(
      raw({
        material: {
          text: "AL 6061-T6",
          confidence: "high",
          sheet: 1,
          box: null,
          grade: "6061",
          condition: "T6",
          spec: null,
        },
      }),
      { sheets: 4, firstSheet: 4 }
    );
    const unnamed = cleanPart(raw({ partNo: null }), {
      sheets: 4,
      firstSheet: 3,
    });
    const merged = mergeParts([a, unnamed, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].material?.text).toBe("AL 6061-T6");
    expect(merged[0].features).toHaveLength(3);
  });

  it("keeps separate parts apart and won't guess where unnamed pages go", () => {
    const other = raw({
      partNo: {
        text: "5555",
        value: "5555",
        confidence: "high",
        sheet: 1,
        box: null,
      },
    });
    const merged = mergeParts([
      cleanPart(raw(), { sheets: 3, firstSheet: 1 }),
      cleanPart(other, { sheets: 3, firstSheet: 2 }),
      cleanPart(raw({ partNo: null }), { sheets: 3, firstSheet: 3 }),
    ]);
    expect(merged.map((p) => p.titleBlock.partNo?.value)).toEqual([
      "1234-01",
      "5555",
    ]);
  });
});

describe("tolerances", () => {
  it("finds the tightest, halving GD&T zones and converting mm only to compare", () => {
    const r = reading({
      tolerances: [
        tol("±.005", 0.005),
        tol("⌖ Ø.0008 A B", 0.0008, "gdt"),
        tol("Ra 16", 16, "surface"),
      ],
    });
    expect(tightestTolerance(r)?.text).toBe("⌖ Ø.0008 A B");
    const mm = reading({
      units: "mm",
      tolerances: [tol("±0.05", 0.05), tol("±0.01", 0.01)],
    });
    expect(tightestTolerance(mm)?.text).toBe("±0.01");
  });
});

describe("checking a drawing against the shop", () => {
  it("flags a metric drawing without converting it", () => {
    const r = reading({ units: "mm", tolerances: [tol("±0.02", 0.02)] });
    const out = checkDrawing(r, ctx());
    expect(kinds(out)).toEqual(["units"]);
    expect(r.tolerances[0].text).toBe("±0.02");
  });

  it("flags tolerances tighter than the shop holds, in mm too", () => {
    expect(
      kinds(
        checkDrawing(reading({ tolerances: [tol("±.0003", 0.0003)] }), ctx())
      )
    ).toContain("tolerance");
    expect(
      kinds(
        checkDrawing(reading({ tolerances: [tol("±.0005", 0.0005)] }), ctx())
      )
    ).not.toContain("tolerance");
    // 0.01 mm ≈ 0.0004 in: tighter than ±0.0005 in.
    expect(
      kinds(
        checkDrawing(
          reading({ units: "mm", tolerances: [tol("±0.01", 0.01)] }),
          ctx()
        )
      )
    ).toContain("tolerance");
    // A grinder that holds 0.0002 covers it.
    expect(
      kinds(
        checkDrawing(
          reading({ tolerances: [tol("±.0003", 0.0003)] }),
          ctx({
            machines: [
              { name: "Grinder", envelope: null, toleranceIn: 0.0002 },
            ],
          })
        )
      )
    ).not.toContain("tolerance");
  });

  it("flags a material the shop has never bought", () => {
    const out = checkDrawing(reading(), ctx({ materialKnown: false }));
    expect(kinds(out)).toContain("new_material");
    expect(out.flags[0].sheet).toBe(1);
    expect(out.flags[0].box).toEqual([10, 10, 20, 20]);
  });

  it("flags finishes: sent out to a known supplier, or unknown", () => {
    const anodize = {
      ...v("ANODIZE PER MIL-A-8625 TYPE II CL 1"),
      kind: "anodize" as const,
      spec: "MIL-A-8625",
    };
    const blacken = { ...v("BLACK OXIDE"), kind: "other" as const, spec: null };
    const out = checkDrawing(
      reading({ finishes: [anodize, blacken] }),
      ctx({
        outsideProcesses: [
          { process: "Anodizing", supplier: "Valley Anodize" },
        ],
      })
    );
    expect(out.flags.map((f) => f.message)).toEqual([
      expect.stringContaining("Valley Anodize"),
      expect.stringContaining("in house"),
    ]);
  });

  it("flags a part larger than every machine, in any orientation", () => {
    const big = reading({ envelope: v("30 x 4 x 2", { l: 30, w: 4, h: 2 }) });
    const mill = {
      name: "VF2",
      envelope: { x: 30, y: 16, z: 20 },
      toleranceIn: null,
    };
    const small = {
      name: "Mini",
      envelope: { x: 10, y: 8, z: 8 },
      toleranceIn: null,
    };
    expect(kinds(checkDrawing(big, ctx({ machines: [small] })))).toContain(
      "envelope"
    );
    expect(
      kinds(checkDrawing(big, ctx({ machines: [small, mill] })))
    ).not.toContain("envelope");
    // No machine sizes given: nothing to check against.
    expect(
      kinds(
        checkDrawing(
          big,
          ctx({ machines: [{ name: "X", envelope: null, toleranceIn: null }] })
        )
      )
    ).toEqual([]);
    // Round part on a lathe.
    const shaft = reading({
      envelope: v("Ø2 x 12", { diameter: 2, length: 12 }),
    });
    const lathe = {
      name: "Lathe",
      envelope: { diameter: 3, length: 10 },
      toleranceIn: null,
    };
    expect(kinds(checkDrawing(shaft, ctx({ machines: [lathe] })))).toContain(
      "envelope"
    );
    // Metric: 600 mm is about 23.6 in, which fits the VF2.
    const metric = reading({
      units: "mm",
      envelope: v("600 x 50 x 20", { l: 600, w: 50, h: 20 }),
    });
    expect(
      kinds(checkDrawing(metric, ctx({ machines: [mill] })))
    ).not.toContain("envelope");
    expect(machineEnvelope({ x: 1 })).toBeNull();
  });

  it("flags certifications the shop doesn't hold, once each", () => {
    const r = reading({
      requirements: [
        { ...v("SUPPLIER SHALL BE AS9100D CERTIFIED"), kind: "certification" },
        { ...v("ITAR CONTROLLED"), kind: "itar" },
        { ...v("AS9100 REQUIRED"), kind: "certification" },
        { ...v("FAI PER AS9102"), kind: "fai" },
      ],
    });
    expect(
      checkDrawing(r, ctx()).flags.filter((f) => f.kind === "certification")
    ).toHaveLength(2);
    expect(
      checkDrawing(
        r,
        ctx({ certifications: ["AS9100 Rev D", "ITAR registered"] })
      ).flags
    ).toEqual([]);
  });

  it("flags hard-to-read values and asks the customer about them", () => {
    const r = reading({
      material: {
        ...v("AL 6O61-T6?", "AL 6061", "low"),
        grade: null,
        condition: null,
        spec: null,
      },
    });
    const out = checkDrawing(r, ctx());
    expect(kinds(out)).toContain("low_confidence");
    expect(out.questions[0]).toContain("confirm the material");
  });

  it("flags a revision or material that differs from the RFQ, and asks", () => {
    const out = checkDrawing(
      reading(),
      ctx({
        line: {
          partNo: "1234-01",
          rev: "B",
          materialText: "304 stainless",
          finish: null,
        },
      })
    );
    expect(kinds(out)).toEqual(["conflict", "conflict"]);
    expect(out.questions).toHaveLength(2);
    const same = checkDrawing(
      reading(),
      ctx({
        line: {
          partNo: "1234 01",
          rev: "rev c",
          materialText: "6061-T6 aluminum",
          finish: null,
        },
      })
    );
    expect(same.flags).toEqual([]);
  });

  it("asks for the material when the drawing doesn't give one", () => {
    expect(checkDrawing(reading({ material: null }), ctx()).questions).toEqual([
      expect.stringContaining("What material"),
    ]);
  });

  it("asks for a drawing when only a 3D model came", () => {
    const r = noDrawingReading(
      { id: "m", name: "part.step" },
      "1234-01",
      "2026-11-02"
    );
    expect(kinds(r)).toEqual(["no_drawing"]);
    expect(r.questions[0]).toContain("PDF drawing for 1234-01");
  });
});

describe("matching drawn parts to RFQ lines", () => {
  const part = (partNo: string | null, drawingNo: string | null = null) =>
    reading({
      titleBlock: {
        ...(partNo ? { partNo: v(partNo) } : {}),
        ...(drawingNo ? { drawingNo: v(drawingNo) } : {}),
      },
    });

  it("matches by part or drawing number and makes lines for the rest", () => {
    const lines = [
      { id: "a", partNo: "1234-01" },
      { id: "b", partNo: "D-77" },
      { id: "c", partNo: "9999" },
    ];
    const extra = part("5555");
    const { update, create } = assignParts(lines, [
      part("1234 01"),
      part(null, "d77"),
      extra,
    ]);
    expect([...update.keys()]).toEqual(["a", "b"]);
    expect(create).toEqual([extra]);
  });

  it("pairs one unmatched part with one unmatched line", () => {
    const { update, create } = assignParts(
      [{ id: "a", partNo: "CUST-1" }],
      [part("1234-01")]
    );
    expect(update.has("a")).toBe(true);
    expect(create).toEqual([]);
  });

  it("keeps the first drawing when the same part is drawn twice", () => {
    const first = part("1234-01");
    const { update, create } = assignParts(
      [{ id: "a", partNo: "1234-01" }],
      [first, part("1234-01")]
    );
    expect(update.get("a")).toBe(first);
    expect(create).toEqual([]);
  });

  it("fills only what the customer left empty", () => {
    const r = reading({
      finishes: [{ ...v("CLEAR ANODIZE"), kind: "anodize", spec: null }],
      tolerances: [tol("±.001", 0.001), tol("Ra 32", 32, "surface")],
    });
    expect(
      linePatch(
        {
          partNo: "1234-01",
          rev: null,
          materialText: "6061",
          finish: null,
          tolerances: null,
        },
        r
      )
    ).toEqual({
      rev: "C",
      finish: "CLEAR ANODIZE",
      tolerances: "±.001 (tightest), surface Ra 32",
    });
  });
});

describe("merging and splitting lines", () => {
  const line = {
    description: null,
    drawing: null,
    fileId: null,
    finish: null,
    materialId: null,
    materialText: "6061",
    notes: null,
    partId: null,
    partNo: "1234-01",
    qtys: [100, 500],
    rev: null,
    tolerances: null,
  };

  it("keeps the kept line's values and fills its gaps", () => {
    const { merged, requantified } = mergeLines(line, {
      ...line,
      partNo: "OTHER",
      rev: "C",
      drawing: { x: 1 },
      qtys: [500, 1000],
    });
    expect(merged.partNo).toBe("1234-01");
    expect(merged.rev).toBe("C");
    expect(merged.drawing).toEqual({ x: 1 });
    expect(merged.qtys).toEqual([100, 500, 1000]);
    expect(requantified).toBe(true);
    expect(mergeLines(line, { ...line, qtys: [100] }).requantified).toBe(false);
  });

  it("splits into a copy without the part's identity", () => {
    const copy = splitLine({ ...line, rev: "C", partId: "p" }, 2);
    expect(copy).toMatchObject({
      partNo: null,
      rev: null,
      partId: null,
      materialText: "6061",
    });
    expect(copy.notes).toContain("line 2");
  });
});

describe("drawing accuracy scoring", () => {
  const expected = {
    partNo: "1234-01",
    rev: "C",
    material: "6061-T6",
    finish: "Clear anodize",
    tightestTolerance: 0.0005,
    breaks: [],
  };

  it("scores fields and catches confident mistakes", () => {
    const good = reading({
      finishes: [
        { ...v("CLEAR ANODIZE TYPE II"), kind: "anodize", spec: null },
      ],
      tolerances: [tol("±.0005", 0.0005)],
    });
    const s = scoreDrawing(expected, [good]);
    expect([s.material.ok, s.rev.ok, s.finish.ok, s.tolerance.ok]).toEqual([
      true,
      true,
      true,
      true,
    ]);

    const wrong = reading({
      titleBlock: { partNo: v("1234-01"), rev: v("B", "B") },
      material: {
        ...v("304 SS", "304", "low"),
        grade: "304",
        condition: null,
        spec: null,
      },
    });
    const w = scoreDrawing(expected, [wrong]);
    expect(w.rev).toMatchObject({ ok: false, silent: true });
    expect(w.material).toMatchObject({ ok: false, silent: false });
    expect(w.finish).toMatchObject({ ok: false, silent: false });

    const summary = summarizeDrawings([s, w]);
    expect(summary.fields.material).toMatchObject({
      n: 1,
      of: 2,
      passes: false,
    });
    expect(summary.silentlyWrong).toEqual([
      { field: "rev", partNo: "1234-01", read: "B" },
    ]);
    expect(summary.passes).toBe(false);
  });
});

describe("tolerances, machine by machine", () => {
  const envelope = v("10 × 6 × 2", { l: 10, w: 6, h: 2 });
  const tight = reading({ tolerances: [tol("±.0003", 0.0003)], envelope });
  const message = (r: ReturnType<typeof checkDrawing>) =>
    r.flags.find((f) => f.kind === "tolerance")?.message ?? "";

  it("no machine holds it: says which comes closest", () => {
    const out = checkDrawing(
      tight,
      ctx({
        machines: [
          { name: "HAAS-VF2", envelope: null, toleranceIn: 0.001 },
          { name: "HAAS-VF4", envelope: null, toleranceIn: 0.0005 },
        ],
      })
    );
    expect(message(out)).toContain("tighter than any of your machines");
    expect(message(out)).toContain("on HAAS-VF4");
  });

  it("the one machine that holds it is too small for the part", () => {
    const out = checkDrawing(
      tight,
      ctx({
        machines: [
          {
            name: "Grinder",
            envelope: { x: 8, y: 4, z: 4 },
            toleranceIn: 0.0002,
          },
          {
            name: "HAAS-VF4",
            envelope: { x: 40, y: 20, z: 20 },
            toleranceIn: 0.001,
          },
        ],
      })
    );
    expect(message(out)).toBe(
      "±.0003: only Grinder holds this, and the part is larger than it."
    );
  });

  it("a machine that holds it and fits: no flag", () => {
    const out = checkDrawing(
      tight,
      ctx({
        machines: [
          {
            name: "Grinder",
            envelope: { x: 24, y: 12, z: 8 },
            toleranceIn: 0.0002,
          },
        ],
      })
    );
    expect(kinds(out)).not.toContain("tolerance");
  });

  it("a machine with no size given might fit: no flag", () => {
    const out = checkDrawing(
      tight,
      ctx({
        machines: [{ name: "Grinder", envelope: null, toleranceIn: 0.0002 }],
      })
    );
    expect(kinds(out)).not.toContain("tolerance");
  });

  it("a machine with no tolerance of its own holds the shop's", () => {
    const ok = reading({ tolerances: [tol("±.0005", 0.0005)] });
    const machines = [{ name: "Mill", envelope: null, toleranceIn: null }];
    expect(kinds(checkDrawing(ok, ctx({ machines })))).not.toContain(
      "tolerance"
    );
    expect(
      kinds(checkDrawing(tight, ctx({ machines: [...machines] })))
    ).toContain("tolerance");
  });
});

describe("scanned drawings", () => {
  it("are flagged so the numbers get checked", () => {
    const out = checkDrawing(reading({ scanned: true }), ctx());
    expect(kinds(out)).toContain("scanned");
    expect(kinds(checkDrawing(reading(), ctx()))).not.toContain("scanned");
  });

  it("a hard-to-read tightest tolerance: flagged and asked", () => {
    const blurry = {
      ...tol("±.0O05", 0.0005),
      confidence: "low" as const,
    };
    const out = checkDrawing(
      reading({ scanned: true, tolerances: [blurry] }),
      ctx()
    );
    expect(out.flags.map((f) => f.message)).toContain(
      'The tightest tolerance was hard to read ("±.0O05"). Check it on the drawing.'
    );
    expect(out.questions).toContain(
      'For 1234-01, please confirm the tightest tolerance: we read it as "±.0O05".'
    );
  });
});
