import { describe, expect, it } from "vitest";
import {
  boxStyle,
  buildUpRows,
  describeSource,
  sourceHref,
  topIssues,
} from "../lib/quotes/review";
import type { DrawingReading, PriceBuildUp } from "../lib/quotes/types";

describe("drawing highlight boxes", () => {
  it("maps 0–1000 boxes to sheet percentages", () => {
    expect(boxStyle([100, 200, 300, 600])).toEqual({
      top: "10%",
      left: "20%",
      height: "20%",
      width: "40%",
    });
  });

  it("clamps, orders swapped corners and drops unusable boxes", () => {
    expect(boxStyle([-50, 900, 100, 1200])).toEqual({
      top: "0%",
      left: "90%",
      height: "10%",
      width: "10%",
    });
    expect(boxStyle([300, 600, 100, 200])).toEqual({
      top: "10%",
      left: "20%",
      height: "20%",
      width: "40%",
    });
    expect(boxStyle(null)).toBeNull();
    expect(boxStyle([5, 5, 5, 400])).toBeNull();
    expect(
      boxStyle([Number.NaN, 0, 10, 10] as [number, number, number, number])
    ).toBeNull();
  });
});

describe("sources", () => {
  it("describes a source in plain words", () => {
    expect(
      describeSource({ kind: "po", label: "PO 4512", date: "2026-03-03" })
    ).toBe("Purchase order · PO 4512 · Mar 3, 2026");
    expect(describeSource({ kind: "default", label: "Not known yet" })).toBe(
      "Default (nothing behind it yet) · Not known yet"
    );
  });

  it("links to the record when there is a page for it", () => {
    expect(
      sourceHref({ kind: "similar_part", label: "Like P-2001", ref: "P-2001" })
    ).toBe("/shop/parts?q=P-2001");
    expect(sourceHref({ kind: "setting", label: "Shop labor rate" })).toBe(
      "/settings/quoting"
    );
    expect(sourceHref({ kind: "default", label: "x" })).toBeNull();
    expect(sourceHref({ kind: "po", label: "PO" })).toBeNull();
  });
});

const drawing = (
  flags: DrawingReading["flags"],
  questions: string[] = []
): DrawingReading => ({ flags, questions }) as unknown as DrawingReading;

describe("top of the screen", () => {
  it("puts price-changing flags first and asks each question once", () => {
    const { flags, questions } = topIssues(
      [
        {
          id: "a",
          label: "Line 1",
          drawing: drawing(
            [
              {
                kind: "low_confidence",
                message: "Rev unclear",
                sheet: 1,
                box: null,
              },
              {
                kind: "tolerance",
                message: "±0.0002 is tight",
                sheet: 1,
                box: null,
              },
              {
                kind: "tolerance",
                message: "±0.0002 is tight",
                sheet: 1,
                box: null,
              },
            ],
            ["Which rev?"]
          ),
        },
        {
          id: "b",
          label: "Line 2",
          drawing: drawing(
            [
              {
                kind: "no_drawing",
                message: "No drawing",
                sheet: null,
                box: null,
              },
            ],
            ["which rev?", "Send a PDF drawing?"]
          ),
        },
        { id: "c", label: "Line 3", drawing: null },
      ],
      ["Send a PDF drawing?", "Confirm quantities"]
    );
    expect(flags.map((f) => f.flag.kind)).toEqual([
      "no_drawing",
      "tolerance",
      "low_confidence",
    ]);
    expect(flags[0]?.lineId).toBe("b");
    expect(questions).toEqual([
      "Which rev?",
      "Send a PDF drawing?",
      "Confirm quantities",
    ]);
  });
});

describe("build-up rows", () => {
  const source = { kind: "routing" as const, label: "Routing" };
  const b = {
    qty: 10,
    material: { perPart: 4, source: { kind: "po", label: "PO 1" } },
    operations: [
      { cost: 50, isDefault: false },
      { cost: 30, isDefault: true },
    ],
    outside: [{ cost: 20, source }],
    unitCost: 14,
    unitPrice: 20,
    margin: { pct: 0.3 },
  } as unknown as PriceBuildUp;

  it("shows each component per part, defaults marked", () => {
    const rows = buildUpRows(b);
    expect(rows.map((r) => [r.key, r.amount])).toEqual([
      ["material", 4],
      ["operations", 8],
      ["outside", 2],
      ["cost", 14],
      ["margin", 6],
      ["price", 20],
    ]);
    expect(rows.find((r) => r.key === "operations")?.isDefault).toBe(true);
    expect(rows.find((r) => r.key === "margin")?.label).toBe("Margin (30%)");
  });

  it("keeps unknown amounts unknown", () => {
    const rows = buildUpRows({
      ...b,
      operations: [],
      outside: [],
      unitCost: null,
    } as PriceBuildUp);
    expect(rows.find((r) => r.key === "operations")?.amount).toBeNull();
    expect(rows.find((r) => r.key === "margin")?.amount).toBeNull();
  });
});
