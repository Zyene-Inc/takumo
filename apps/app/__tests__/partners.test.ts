import { describe, expect, test } from "vitest";
import { utils, write } from "xlsx";
import {
  COLUMNS,
  readAnswerKey,
  SHEETS,
  templateWorkbook,
} from "../evals/partners/answer-key";
import {
  compareFeasibility,
  compareLine,
  sameThing,
  summarize,
} from "../evals/partners/compare";

const workbook = (
  quotes: unknown[][],
  feasibility: unknown[][] = [],
  shop: unknown[][] = [
    ["shop_name", "Test Shop"],
    ["org_id", "org_test"],
    ["win_rate", "30%"],
  ]
) => {
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet(shop), SHEETS.shop);
  utils.book_append_sheet(
    book,
    utils.aoa_to_sheet([[...COLUMNS.quotes], ...quotes]),
    SHEETS.quotes
  );
  if (feasibility.length) {
    utils.book_append_sheet(
      book,
      utils.aoa_to_sheet([[...COLUMNS.feasibility], ...feasibility]),
      SHEETS.feasibility
    );
  }
  return new Uint8Array(
    write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer
  );
};

const row = (
  qty: number,
  price: number | string,
  extra: Partial<Record<string, unknown>> = {}
) => [
  extra.quote_id ?? "Q-1",
  "rfq.eml; dwg.pdf",
  "2026-10-01",
  "2026-10-03",
  "Cobalt Medical",
  extra.part_no ?? "1234-01",
  "C",
  "6061-T6",
  "Clear anodize",
  qty,
  price,
  15,
  "WON",
  75,
];

describe("design-partner answer keys", () => {
  test("the template reads cleanly", () => {
    const { key, problems } = readAnswerKey(new Uint8Array(templateWorkbook()));
    expect(problems).toEqual([]);
    expect(key?.quotes[0].lines[0].breaks).toHaveLength(2);
    expect(key?.feasibility).toHaveLength(1);
  });

  test("rows group into quotes, lines and price breaks", () => {
    const { key, problems } = readAnswerKey(
      workbook([
        row(100, "$18.40"),
        row(500, 12.9),
        row(50, 30, { part_no: "9999" }),
      ]),
      ["rfq.eml", "dwg.pdf"]
    );
    expect(problems).toEqual([]);
    expect(key?.shopName).toBe("Test Shop");
    expect(key?.baseline.winRate).toBeCloseTo(0.3);
    expect(key?.quotes).toHaveLength(1);
    const [quote] = key?.quotes ?? [];
    expect(quote.files).toEqual(["rfq.eml", "dwg.pdf"]);
    expect(quote.outcome).toBe("won");
    expect(quote.lines.map((l) => l.partNo)).toEqual(["1234-01", "9999"]);
    expect(quote.lines[0].breaks).toEqual([
      { qty: 100, unitPrice: 18.4, leadTimeDays: 15 },
      { qty: 500, unitPrice: 12.9, leadTimeDays: 15 },
    ]);
  });

  test("problems name the sheet, row and column, and missing files", () => {
    const { key, problems } = readAnswerKey(
      workbook(
        [row(0, 18.4), row(100, "abc"), row(100, 5), row(100, 6)],
        [
          [
            "F-1",
            "2026-10-20",
            "1234-01",
            "C",
            300,
            "2026-10-24",
            "maybe",
            "",
            "",
            "",
          ],
        ],
        [["shop_name", "Test Shop"]]
      ),
      ["rfq.eml"]
    );
    expect(key).toBeNull();
    const text = problems.map(
      (p) => `${p.sheet}${p.row ? ` ${p.row}` : ""}: ${p.message}`
    );
    expect(text).toContain("Shop: org_id is required");
    expect(text).toContain("Quotes 2: qty must be above 0");
    expect(text.some((t) => t.startsWith("Quotes 3: unit_price"))).toBe(true);
    expect(text).toContain(
      "Quotes 5: quantity 100 of 1234-01 is listed twice in Q-1"
    );
    expect(text).toContain(
      'Feasibility 2: planner_answer must be "yes" or "no"'
    );
    expect(text).toContain(
      'Quotes: Q-1: file "dwg.pdf" isn\'t in the files folder'
    );
  });
});

describe("comparing Takumo with what the shop sent", () => {
  const expected = {
    partNo: "1234-01",
    rev: "C",
    material: "6061-T6",
    finish: "Clear anodize Type II",
    breaks: [
      { qty: 100, unitPrice: 18.4, leadTimeDays: 15 },
      { qty: 500, unitPrice: 12.9, leadTimeDays: 20 },
    ],
  };

  test("a close draft counts as a small edit; a far one doesn't", () => {
    const r = compareLine(expected, [
      {
        partNo: "1234-01",
        rev: "c",
        material: "AL6061-T6 bar 2in",
        finish: "anodize clear type II",
        qtys: [100, 500],
        breaks: [
          { qty: 100, unitPrice: 19, leadTimeDays: 16 },
          { qty: 500, unitPrice: 15, leadTimeDays: 30 },
        ],
      },
    ]);
    expect(r).toMatchObject({
      found: true,
      revOk: true,
      qtysOk: true,
      materialOk: true,
      finishOk: true,
    });
    expect(r.breaks[0]).toMatchObject({
      priceOk: true,
      leadTimeOk: true,
      leadTimeDiffDays: 1,
    });
    expect(r.breaks[0].priceDiff).toBeCloseTo(19 / 18.4 - 1);
    expect(r.breaks[1]).toMatchObject({ priceOk: false, leadTimeOk: false });
  });

  test("a part Takumo didn't find scores as missing, not as right", () => {
    const r = compareLine(expected, []);
    expect(r).toMatchObject({ found: false, qtysOk: false, materialOk: false });
    expect(r.breaks.every((b) => !b.priceOk && b.draftUnitPrice === null)).toBe(
      true
    );
    const s = summarize([r], []);
    expect(s.quotes.priceWithin5pct).toEqual({ n: 0, of: 2 });
    expect(s.quotes.priced).toEqual({ n: 0, of: 2 });
  });

  test("material and finish match when they name the same thing", () => {
    expect(sameThing("6061-T6", "AL6061-T6 bar 2in")).toBe(true);
    expect(sameThing("Clear anodize Type II", "Type II anodize, clear")).toBe(
      true
    );
    expect(sameThing("304 stainless", "6061-T6")).toBe(false);
    expect(sameThing(null, "anything")).toBeNull();
  });

  test("delivery answers: agreement and days off, old cases marked", () => {
    const c = {
      id: "F-1",
      askedDate: "2026-11-01",
      partNo: "1234-01",
      rev: "C",
      qty: 300,
      requestedDate: "2026-11-06",
      plannerAnswer: "no" as const,
      plannerDate: "2026-11-11",
      actualShipDate: "2026-11-10",
      notes: null,
    };
    const r = compareFeasibility(
      c,
      { canTake: false, date: "2026-11-12" },
      "2026-11-02"
    );
    expect(r).toMatchObject({
      agrees: true,
      historical: false,
      vsPlannerDays: 1,
      vsActualDays: 2,
    });
    expect(compareFeasibility(c, null, "2026-11-20")).toMatchObject({
      agrees: null,
      historical: true,
    });
    expect(summarize([], [r]).feasibility.agrees).toEqual({ n: 1, of: 1 });
  });
});
