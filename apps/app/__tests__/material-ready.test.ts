import { describe, expect, test } from "vitest";
import {
  type MaterialOrder,
  type MaterialPart,
  materialReady,
  type PoRow,
  type StockRow,
} from "../lib/schedule/material";

const today = "2026-11-04";
const materials = new Map([
  ["al", { name: "6061 2in bar", unit: "ft", leadTimeDays: 10 }],
  ["ss", { name: "304 plate", unit: "lb", leadTimeDays: null }],
]);
const parts = new Map<string, MaterialPart>([
  ["p1", { materialId: "al", qtyPerUnit: 0.5, unit: "ft" }],
  ["p2", { materialId: "ss", qtyPerUnit: 2, unit: null }],
  ["p3", { materialId: "al", qtyPerUnit: null, unit: null }],
  ["p4", { materialId: null, qtyPerUnit: 1, unit: null }],
]);
const order = (
  orderNo: string,
  partId: string,
  qty: number,
  due: string,
  started = false
): MaterialOrder => ({
  orderNo,
  partId,
  qty,
  dueDate: new Date(`${due}T00:00:00Z`),
  started,
});
const po = (
  poNo: string,
  materialId: string,
  qty: number,
  due: string
): PoRow => ({
  poNo,
  materialId,
  qtyOrdered: qty,
  qtyReceived: 0,
  unit: null,
  status: "open",
  dueDate: new Date(`${due}T00:00:00Z`),
});
const run = (
  orders: MaterialOrder[],
  stock: StockRow[],
  pos: PoRow[],
  extra?: MaterialOrder
) => materialReady({ orders, stock, pos, parts, materials, today, extra });

describe("material-ready dates", () => {
  test("on hand: ready today, with the amount in words", () => {
    const r = run(
      [order("SO-1", "p1", 20, "2026-11-20")],
      [{ materialId: "al", qtyOnHand: 12, qtyAllocated: 0, unit: "FT" }],
      []
    );
    expect(r.get("SO-1")).toMatchObject({ date: null, unknown: false });
    expect(r.get("SO-1")?.note).toBe("10 ft of 6061 2in bar on hand");
  });

  test("orders take stock in due-date order: the later one waits for the PO", () => {
    const r = run(
      [
        order("LATE", "p1", 20, "2026-12-01"),
        order("SOON", "p1", 20, "2026-11-10"),
      ],
      [{ materialId: "al", qtyOnHand: 12, qtyAllocated: 0, unit: null }],
      [po("PO-4471", "al", 50, "2026-11-12")]
    );
    expect(r.get("SOON")?.date).toBeNull();
    expect(r.get("LATE")?.date).toBe("2026-11-12");
    expect(r.get("LATE")?.note).toContain("arrives Thu Nov 12 on PO-4471");
  });

  test("PO lines are shared too: two orders don't both count one delivery", () => {
    const r = run(
      [order("A", "p1", 40, "2026-11-10"), order("B", "p1", 40, "2026-11-11")],
      [],
      [po("PO-1", "al", 20, "2026-11-12"), po("PO-2", "al", 20, "2026-11-20")]
    );
    expect(r.get("A")?.date).toBe("2026-11-12");
    expect(r.get("B")?.date).toBe("2026-11-20");
  });

  test("not on hand or on order: lead time, flagged not ordered", () => {
    const r = run([order("A", "p1", 40, "2026-11-30")], [], []);
    expect(r.get("A")).toMatchObject({ date: "2026-11-14", notOrdered: true });
    expect(r.get("A")?.note).toContain("not ordered yet");
  });

  test("no lead time set: flagged, never a made-up date", () => {
    const r = run([order("A", "p2", 5, "2026-11-30")], [], []);
    expect(r.get("A")).toMatchObject({ date: null, notOrdered: true });
    expect(r.get("A")?.note).toContain("no lead time set");
  });

  test("stock the ERP set aside goes to existing orders, not a new one", () => {
    const stock = [
      { materialId: "al", qtyOnHand: 10, qtyAllocated: 10, unit: null },
    ];
    const r = run(
      [order("OLD", "p1", 20, "2026-11-30")],
      stock,
      [po("PO-9", "al", 100, "2026-11-18")],
      order("NEW", "p1", 4, "2026-11-20")
    );
    expect(r.get("OLD")?.date).toBeNull();
    expect(r.get("NEW")?.date).toBe("2026-11-18");
  });

  test("started orders already have their material; unknowns say why", () => {
    const r = run(
      [
        order("RUN", "p1", 1000, "2026-11-05", true),
        order("NOUSE", "p3", 5, "2026-11-10"),
        order("NOMAT", "p4", 5, "2026-11-10"),
      ],
      [],
      []
    );
    expect(r.has("RUN")).toBe(false);
    expect(r.get("NOUSE")).toMatchObject({ unknown: true, date: null });
    expect(r.get("NOUSE")?.note).toContain("isn't known");
    expect(r.get("NOMAT")?.note).toContain("not set on the part");
  });

  test("an overdue PO is ready today, and says it's overdue", () => {
    const r = run(
      [order("A", "p1", 10, "2026-11-30")],
      [],
      [po("PO-7", "al", 10, "2026-11-01")]
    );
    expect(r.get("A")?.date).toBeNull();
    expect(r.get("A")?.note).toContain("overdue");
  });
});
