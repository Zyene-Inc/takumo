// @vitest-environment node
// ERP reports by email against a real database (F1.3 edge cases): a resent
// file is skipped, and a report whose columns the ERP renamed is recognised
// and confirmed in one click, taking over from the old one. Runs only with
// TEST_DATABASE_URL (a disposable database with the migrations applied).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

vi.mock("server-only", () => ({}));
// The database package resolves its own copy of the guard.
vi.mock("../../../packages/database/node_modules/server-only", () => ({}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Offline column suggestions: no AI in tests.
vi.mock("@repo/ingest/ai-mapping", async () => {
  const { suggestMapping, detectEntity } = await import("@repo/ingest");
  return {
    suggestMappingWithAi: ({ headers }: { headers: string[] }) =>
      suggestMapping(detectEntity(headers), headers),
  };
});
vi.mock("../lib/ai-usage", () => ({
  budgetProblem: async () => "no AI in tests",
  recordUsage: vi.fn(),
}));
vi.mock("../lib/quotes/settle", () => ({
  settleFromErp: async () => ({ won: 0, lost: 0 }),
}));
vi.mock("../lib/orders/settle", () => ({
  markEnteredFromErp: async () => 0,
}));

const HEADERS = ["order_no", "customer", "part_no", "qty", "due_date"];
const RENAMED = ["order_no", "customer", "part_no", "qty", "ship_by"];

const sheet = (
  headers: string[],
  rows: string[][],
  name = "Open Jobs.csv"
) => ({
  name,
  firstRow: 2,
  headers,
  rows: rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]]))),
});

const ROWS = [
  ["SO-1", "Northwind", "P-1", "10", "2026-11-20"],
  ["SO-2", "Bluefin", "P-2", "5", "2026-11-25"],
];

describe.skipIf(!TEST_DATABASE_URL)("ERP reports (database)", async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const { database } = await import("@repo/database");
  const { handleReportSheet, confirmReport } = await import(
    "../lib/erp/reports"
  );
  const orgId = `org_reports_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await database.org.create({ data: { id: orgId, name: "Reports test" } });
  });
  afterAll(async () => {
    await database.org.deleteMany({ where: { id: orgId } });
    await database.$disconnect();
  });

  let firstId = "";

  test("the first report waits for its columns, then imports", async () => {
    const out = await handleReportSheet(orgId, sheet(HEADERS, ROWS));
    expect(out.status).toBe("needs_mapping");
    const report = await database.erpReport.findFirstOrThrow({
      where: { orgId },
    });
    firstId = report.id;
    const done = await confirmReport(
      orgId,
      report.id,
      report.mapping as never,
      "full"
    );
    expect(done.ok).toBe(true);
    expect(await database.order.count({ where: { orgId } })).toBe(2);
  });

  test("the same file again is skipped; a changed one imports", async () => {
    const again = await handleReportSheet(orgId, sheet(HEADERS, ROWS));
    expect(again.status).toBe("imported");
    // That import stamped the file; a resend now is a no-op.
    const resend = await handleReportSheet(orgId, sheet(HEADERS, ROWS));
    expect(resend.status).toBe("duplicate");
    const changed = await handleReportSheet(
      orgId,
      sheet(HEADERS, [...ROWS, ["SO-3", "Cobalt", "P-3", "7", "2026-12-01"]])
    );
    expect(changed.status).toBe("imported");
    expect(await database.order.count({ where: { orgId } })).toBe(3);
  });

  test("a renamed column: recognised, confirmed in one click, replaces the old report", async () => {
    const rows = [
      ["SO-1", "Northwind", "P-1", "10", "2026-11-21"],
      ["SO-3", "Cobalt", "P-3", "7", "2026-12-01"],
    ];
    const out = await handleReportSheet(
      orgId,
      sheet(RENAMED, rows, "Open Jobs (1).csv")
    );
    expect(out.status).toBe("needs_mapping");
    if (out.status !== "needs_mapping") {
      return;
    }
    expect(out.replaces?.report.id).toBe(firstId);
    expect(out.replaces?.renamed).toEqual([
      { from: "due_date", to: "ship_by" },
    ]);
    expect(out.replaces?.complete).toBe(true);
    // Nothing imported yet: SO-1's date is unchanged.
    const so1 = () =>
      database.order.findFirstOrThrow({ where: { orgId, orderNo: "SO-1" } });
    expect((await so1()).dueDate.toISOString().slice(0, 10)).toBe("2026-11-20");

    // The next night's copy still knows what it replaces.
    const next = await handleReportSheet(
      orgId,
      sheet(RENAMED, rows, "Open Jobs (1).csv")
    );
    expect(next.status === "needs_mapping" && next.replaces?.report.id).toBe(
      firstId
    );

    // One click: the carried-over columns, the old report's mode.
    const waiting = await database.erpReport.findFirstOrThrow({
      where: { orgId, status: "needs_mapping" },
    });
    expect(waiting.mode).toBe("full");
    const done = await confirmReport(
      orgId,
      waiting.id,
      waiting.mapping as never,
      "full",
      true
    );
    expect(done.ok).toBe(true);
    expect((await so1()).dueDate.toISOString().slice(0, 10)).toBe("2026-11-21");
    // The old report is gone, so this is the one full report of its kind:
    // SO-2, no longer listed, is closed.
    const reports = await database.erpReport.findMany({ where: { orgId } });
    expect(reports.map((r) => r.id)).toEqual([waiting.id]);
    const so2 = await database.order.findFirstOrThrow({
      where: { orgId, orderNo: "SO-2" },
    });
    expect(so2.status).toBe("done");
  });

  test("a confirm that can't read the rows keeps the old report", async () => {
    const bad = await handleReportSheet(
      orgId,
      sheet(
        ["order_no", "customer", "part_no", "qty", "promised"],
        // No part and no quantity: nothing here can be read.
        [["SO-9", "Acme", "", "", "next week"]],
        "Open Jobs (2).csv"
      )
    );
    expect(bad.status).toBe("needs_mapping");
    const waiting = await database.erpReport.findFirstOrThrow({
      where: { orgId, status: "needs_mapping" },
    });
    const done = await confirmReport(
      orgId,
      waiting.id,
      waiting.mapping as never,
      "full",
      true
    );
    expect(done.ok).toBe(false);
    const active = await database.erpReport.findMany({
      where: { orgId, status: "active" },
    });
    expect(active).toHaveLength(1);
  });
});
