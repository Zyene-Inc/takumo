import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { planNamed } = await import("../save");
const { detectEntity, suggestMapping } = await import("../match");

const row = (id: string, name: string, externalId: string | null = null) => ({
  id,
  name,
  externalId,
});

describe("planNamed: machines, customers and materials by ERP id", () => {
  test("a rename in the ERP renames the same record", () => {
    const { plans, renamed } = planNamed(
      [row("1", "Acme Corp", "C-100")],
      [{ name: "Acme Corporation", externalId: "C-100" }]
    );
    expect(plans).toEqual([{ id: "1", data: { name: "Acme Corporation" } }]);
    expect(renamed).toEqual(["Acme Corp → Acme Corporation"]);
  });

  test("learns the ERP id of a record matched by name", () => {
    const { plans } = planNamed(
      [row("1", "HAAS-VF2")],
      [{ name: "haas-vf2", externalId: "WC-7" }]
    );
    expect(plans).toEqual([{ id: "1", data: { externalId: "WC-7" } }]);
  });

  test("an ERP id whose new name is taken keeps its record", () => {
    const { plans } = planNamed(
      [row("1", "Bar 6061", "M-1"), row("2", "Bar 7075")],
      [{ name: "Bar 7075", externalId: "M-1" }]
    );
    // Renaming record 1 would take record 2's name: both stay as they are.
    expect(plans).toEqual([{ id: "1", data: {} }]);
  });

  test("a rename onto a name another record has is reported, not done", () => {
    const { plans, clashes, renamed } = planNamed(
      [row("1", "Mill 1", "WC-1"), row("2", "Mill 2", "WC-2")],
      [{ name: "Mill 2", externalId: "WC-1" }]
    );
    expect(plans).toEqual([{ id: "1", data: {} }]);
    expect(clashes).toEqual(["Mill 1 → Mill 2"]);
    expect(renamed).toEqual([]);
  });

  test("two renames that swap through a free name both apply", () => {
    const { plans } = planNamed(
      [row("1", "Lathe A", "WC-1")],
      [
        { name: "Lathe B", externalId: "WC-1" },
        { name: "Lathe A", externalId: "WC-9" },
      ]
    );
    expect(plans[0]).toEqual({ id: "1", data: { name: "Lathe B" } });
    expect(plans[1]).toEqual({
      id: null,
      data: { name: "Lathe A", externalId: "WC-9" },
    });
  });

  test("new records keep their ERP id; rows without one match by name", () => {
    const { plans } = planNamed(
      [row("1", "Delta")],
      [
        { name: "Echo", externalId: "C-5" },
        { name: "Delta", externalId: null },
      ]
    );
    expect(plans).toEqual([
      { id: null, data: { name: "Echo", externalId: "C-5" } },
      { id: "1", data: {} },
    ]);
  });
});

describe("column matching", () => {
  test("finds the ERP id column on a customer report", () => {
    const mapping = suggestMapping("customers", [
      "Cust ID",
      "Customer Name",
      "Terms",
    ]);
    expect(mapping.columns.erpId).toBe("Cust ID");
    expect(mapping.columns.name).toBe("Customer Name");
  });

  test("reads an open-operations report", () => {
    const headers = ["Job", "Oper", "Op Status", "Qty Complete"];
    expect(detectEntity(headers)).toBe("operations");
    const { columns } = suggestMapping("operations", headers);
    expect(columns).toMatchObject({
      orderNo: "Job",
      seq: "Oper",
      status: "Op Status",
      qtyDone: "Qty Complete",
    });
  });

  test("job history is still job history", () => {
    expect(
      detectEntity([
        "Order",
        "Part",
        "Op",
        "Setup",
        "Run",
        "Qty Good",
        "Finished",
      ])
    ).toBe("jobs");
  });
});
