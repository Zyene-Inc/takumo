import { describe, expect, test } from "vitest";
import {
  detectEntity,
  missingRequired,
  parseDate,
  parseNumber,
  parseRows,
  suggestMapping,
} from "../index";

describe("detectEntity", () => {
  test("recognizes the demo shop files", () => {
    expect(
      detectEntity([
        "name",
        "type",
        "hourly_rate",
        "efficiency",
        "hours_per_day",
      ])
    ).toBe("workCenters");
    expect(
      detectEntity([
        "part_no",
        "seq",
        "work_center",
        "setup_min",
        "run_min_per_unit",
        "alt_work_centers",
      ])
    ).toBe("routings");
    expect(
      detectEntity([
        "order_no",
        "customer",
        "part_no",
        "qty",
        "due_date",
        "price",
        "priority",
      ])
    ).toBe("orders");
    expect(
      detectEntity([
        "quote_no",
        "customer",
        "part_no",
        "qty",
        "price",
        "lead_time_days",
        "est_cost",
        "actual_cost",
        "status",
        "quoted_at",
      ])
    ).toBe("quotes");
  });

  test("recognizes typical ERP export headers", () => {
    expect(
      detectEntity([
        "Job #",
        "Part Number",
        "Qty Ordered",
        "Ship Date",
        "Customer",
      ])
    ).toBe("orders");
    expect(
      detectEntity(["Part #", "Op #", "Machine", "Setup (hrs)", "Cycle Time"])
    ).toBe("routings");
  });
});

describe("suggestMapping", () => {
  test("maps messy headers and spots hours", () => {
    const mapping = suggestMapping("routings", [
      "Part #",
      "Op #",
      "Machine",
      "Setup (hrs)",
      "Cycle Time",
      "Notes",
    ]);
    expect(mapping.columns).toMatchObject({
      partNo: "Part #",
      seq: "Op #",
      workCenter: "Machine",
      setupMin: "Setup (hrs)",
      runMinPerUnit: "Cycle Time",
      altWorkCenters: null,
    });
    expect(mapping.timeUnits.setupMin).toBe("hours");
    expect(mapping.timeUnits.runMinPerUnit).toBe("minutes");
    expect(missingRequired(mapping)).toEqual([]);
  });

  test("uses each column once", () => {
    const mapping = suggestMapping("parts", ["Part", "Description"]);
    expect(mapping.columns.partNo).toBe("Part");
    expect(mapping.columns.description).toBe("Description");
  });

  test("lists required fields it could not find", () => {
    const mapping = suggestMapping("orders", ["Order", "Qty"]);
    expect(missingRequired(mapping)).toEqual(["Part number", "Due date"]);
  });
});

describe("value parsing", () => {
  test("numbers", () => {
    expect(parseNumber("$1,234.50")).toBe(1234.5);
    expect(parseNumber("90%")).toBeCloseTo(0.9);
    expect(parseNumber("Net 30")).toBe(30);
    expect(parseNumber("(50)")).toBe(-50);
    expect(parseNumber("n/a")).toBeNull();
  });

  test("dates", () => {
    expect(parseDate("2026-11-13")).toBe("2026-11-13");
    expect(parseDate("11/13/2026")).toBe("2026-11-13");
    expect(parseDate("11/13/26")).toBe("2026-11-13");
    expect(parseDate("13-Nov-2026")).toBe("2026-11-13");
    expect(parseDate("Nov 13, 2026")).toBe("2026-11-13");
    expect(parseDate(46_339)).toBe("2026-11-13"); // Excel serial
    expect(parseDate(new Date(Date.UTC(2026, 10, 13)))).toBe("2026-11-13");
    expect(parseDate("02/30/2026")).toBeNull();
    expect(parseDate("soon")).toBeNull();
  });
});

describe("parseRows", () => {
  const mapping = suggestMapping("orders", [
    "SO",
    "Part Number",
    "Qty",
    "Due Date",
    "Status",
  ]);

  test("a quantity of zero or less is a row error", () => {
    const result = parseRows(
      [
        { SO: "SO-1", "Part Number": "P-1", Qty: 0, "Due Date": "2026-11-20" },
        {
          SO: "SO-2",
          "Part Number": "P-1",
          Qty: "0.4",
          "Due Date": "2026-11-20",
        },
        { SO: "SO-3", "Part Number": "P-1", Qty: 2, "Due Date": "2026-11-20" },
      ],
      mapping
    );
    expect(result.records.map((r) => r.row)).toEqual([4]);
    expect(result.errors.map((e) => e.message)).toEqual([
      '"0" must be at least 1',
      '"0.4" must be at least 1',
    ]);
  });

  test("converts values, skips bad rows and keeps row numbers", () => {
    const result = parseRows(
      [
        {
          SO: "SO-1",
          "Part Number": "P-1",
          Qty: "1,200",
          "Due Date": "11/13/2026",
          Status: "WIP",
        },
        {
          SO: "SO-2",
          "Part Number": "",
          Qty: 5,
          "Due Date": "2026-11-20",
          Status: "",
        },
        { SO: "", "Part Number": "", Qty: "", "Due Date": "", Status: "" },
        {
          SO: "SO-3",
          "Part Number": "P-2",
          Qty: 3,
          "Due Date": "2026-12-01",
          Status: "parked",
        },
      ],
      mapping
    );
    expect(result.blankRows).toBe(1);
    expect(result.records.map((r) => r.row)).toEqual([2, 5]);
    expect(result.records[0].values).toMatchObject({
      orderNo: "SO-1",
      qty: 1200,
      dueDate: "2026-11-13",
      status: "in_progress",
    });
    // Missing part number: the row is skipped.
    expect(result.errors).toContainEqual({
      row: 3,
      field: "Part number",
      message: "Missing value",
      severity: "error",
    });
    // Unknown status: the row is kept without it.
    expect(result.records[1].values.status).toBeNull();
    expect(result.errors.find((e) => e.row === 5)?.severity).toBe("warning");
  });

  test("converts hours to minutes", () => {
    const routing = suggestMapping("routings", [
      "Part",
      "Op",
      "Machine",
      "Setup Hours",
      "Run Min",
    ]);
    const { records } = parseRows(
      [
        {
          Part: "P-1",
          Op: 10,
          Machine: "VF2",
          "Setup Hours": 1.5,
          "Run Min": 6,
        },
      ],
      routing
    );
    expect(records[0].values).toMatchObject({ setupMin: 90, runMinPerUnit: 6 });
  });
});
