// The ERP renamed, added or dropped a column of a confirmed report (F1.3
// edge cases): Takumo recognises the report, carries its column choices over,
// says what changed, and skips a resent file.
import { type ColumnMapping, suggestMapping } from "@repo/ingest";
import { describe, expect, test } from "vitest";
import { healthLines } from "../lib/erp/health";
import { reportLink } from "../lib/erp/link";
import {
  alike,
  describeRenamed,
  findRenamed,
  type KnownReport,
} from "../lib/erp/renamed";
import { sheetHash } from "../lib/erp/sheets";

const OPEN_JOBS = [
  "Job",
  "Part",
  "Rev",
  "Qty",
  "Due",
  "Customer",
  "Notes",
] as const;

const confirmed = (headers: readonly string[]): KnownReport => {
  const mapping = suggestMapping("orders", headers);
  return {
    id: "r1",
    name: "Open Jobs.xlsx",
    headers: [...headers],
    mapping,
    mode: "full",
  };
};

const columnFor = (m: ColumnMapping, header: string) =>
  Object.entries(m.columns).find(([, h]) => h === header)?.[0];

describe("a confirmed ERP report with renamed columns", () => {
  const report = confirmed(OPEN_JOBS);
  const dueField = columnFor(report.mapping, "Due");

  test("the setup: the confirmed report maps Due to a field", () => {
    expect(dueField).toBeTruthy();
  });

  test("one column renamed: recognised, the choice moves to the new name", () => {
    const now = ["Job", "Part", "Rev", "Qty", "Due Date", "Customer", "Notes"];
    const r = findRenamed(now, [report]);
    expect(r?.report.id).toBe("r1");
    expect(r?.renamed).toEqual([{ from: "Due", to: "Due Date" }]);
    expect(r?.mapping.columns[dueField ?? ""]).toBe("Due Date");
    expect(r?.complete).toBe(true);
    expect(r?.mode).toBe("full");
    // Everything else is untouched.
    for (const [field, header] of Object.entries(report.mapping.columns)) {
      if (field !== dueField) {
        expect(r?.mapping.columns[field]).toBe(header);
      }
    }
  });

  test("renamed to something unlike the old name, the only new column: still paired", () => {
    const now = ["Job", "Part", "Rev", "Qty", "Ship By", "Customer", "Notes"];
    const r = findRenamed(now, [report]);
    expect(r?.renamed).toEqual([{ from: "Due", to: "Ship By" }]);
    expect(r?.complete).toBe(true);
  });

  test("a column added: recognised, nothing lost, the new one noted", () => {
    const now = [...OPEN_JOBS, "Shift"];
    const r = findRenamed(now, [report]);
    expect(r?.renamed).toEqual([]);
    expect(r?.added).toEqual(["Shift"]);
    expect(r?.complete).toBe(true);
    expect(describeRenamed(r ?? { added: [], removed: [], renamed: [] })).toBe(
      '"Shift" is new'
    );
  });

  test("a required column dropped: recognised, but not one click", () => {
    // The order number is required; Notes, never used, isn't a stand-in.
    const jobField = columnFor(report.mapping, "Job");
    expect(jobField).toBeTruthy();
    const r = findRenamed(
      OPEN_JOBS.filter((x) => x !== "Job"),
      [report]
    );
    expect(r?.report.id).toBe("r1");
    expect(r?.removed).toEqual(["Job"]);
    expect(r?.mapping.columns[jobField ?? ""]).toBeNull();
    expect(r?.complete).toBe(false);
  });

  test("different case or punctuation is the same column", () => {
    const now = ["JOB", "part", "Rev.", "Qty", "Due", "Customer", "Notes"];
    expect(findRenamed(now, [report])?.renamed).toEqual([]);
  });

  test("a different report isn't taken for this one", () => {
    const stock = ["Material", "Location", "On Hand", "Allocated", "Unit"];
    expect(findRenamed(stock, [report])).toBeNull();
    // Two shared columns out of seven isn't the same report either.
    expect(
      findRenamed(["Job", "Part", "Machine", "Operator", "Hours"], [report])
    ).toBeNull();
  });

  test("of two confirmed reports, the closer one", () => {
    const other = { ...confirmed(["Job", "Part", "Qty", "Due"]), id: "r2" };
    const now = ["Job", "Part", "Rev", "Qty", "Due Date", "Customer", "Notes"];
    expect(findRenamed(now, [other, report])?.report.id).toBe("r1");
  });

  test("how alike two headers are", () => {
    expect(alike("Due", "Due Date")).toBeGreaterThanOrEqual(0.5);
    expect(alike("Qty Ordered", "Ordered Qty")).toBe(1);
    expect(alike("Qty", "Customer")).toBe(0);
  });
});

describe("the admin's email and the daily check", () => {
  test("the link opens the one report", () => {
    expect(reportLink("abc")).toBe(
      "/settings/integrations/email?report=abc#report-abc"
    );
    expect(reportLink()).toBe("/settings/integrations/email");
  });

  test("a renamed report isn't called 'stopped arriving'", () => {
    const now = new Date("2026-11-04T15:00:00Z");
    const lines = healthLines(
      [
        {
          name: "Open Jobs.xlsx",
          status: "active",
          lastImportAt: new Date("2026-11-02T06:00:00Z"),
          lastReceivedAt: new Date("2026-11-02T06:00:00Z"),
          updatedAt: new Date("2026-11-01T00:00:00Z"),
          renamedTo: "Open Jobs (1).xlsx",
        },
      ],
      [],
      now
    );
    expect(lines[0]).toContain("changed its columns");
    expect(lines[0]).toContain("Open Jobs (1).xlsx");
    expect(lines[0]).not.toContain("scheduled report");
  });
});

describe("a resent report", () => {
  test("the same rows hash the same; a changed cell doesn't", () => {
    const a = { headers: ["Job", "Qty"], rows: [{ Job: "J1", Qty: 5 }] };
    const b = { headers: ["Job", "Qty"], rows: [{ Job: "J1", Qty: 5 }] };
    const c = { headers: ["Job", "Qty"], rows: [{ Job: "J1", Qty: 6 }] };
    expect(sheetHash(a)).toBe(sheetHash(b));
    expect(sheetHash(a)).not.toBe(sheetHash(c));
  });
});

describe("changes to make in the ERP, as a file", async () => {
  const { changesCsv, changesFileName } = await import(
    "../lib/erp/changes-csv"
  );
  const change = {
    fact: "F-12",
    kind: "Operation",
    label: "P-1001 rev B op 10 (HAAS-VF2)",
    field: "Setup time",
    was: "45 min",
    now: "30 min",
    evidence: 'Sam: "with the new vise, setup is 30, not 45"',
    what: "Setup time: 30 min",
    reviewedAt: "2026-11-03T14:00:00.000Z",
  };

  test("one row per change, quoted where needed", () => {
    const [header, row] = changesCsv([change]).split("\r\n");
    expect(header).toBe(
      "Fact,Record type,Record,Field,In your ERP now,Change it to,Why,Approved"
    );
    expect(row).toBe(
      'F-12,Operation,P-1001 rev B op 10 (HAAS-VF2),Setup time,45 min,30 min,"Sam: ""with the new vise, setup is 30, not 45""",2026-11-03'
    );
  });

  test("a reason that starts like a formula isn't run by the spreadsheet", () => {
    const [, row] = changesCsv([
      { ...change, evidence: '=HYPERLINK("http://x")' },
    ]).split("\r\n");
    expect(row).toContain("'=HYPERLINK");
  });

  test("nothing to change: just the header", () => {
    expect(changesCsv([]).split("\r\n")).toHaveLength(1);
    expect(changesFileName(new Date("2026-11-04T12:00:00Z"))).toBe(
      "takumo-erp-changes-2026-11-04.csv"
    );
  });
});
