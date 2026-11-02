import { describe, expect, it } from "vitest";
import {
  incomingByMaterial,
  isLate,
  remaining,
  stockByMaterial,
} from "../app/(authenticated)/shop/materials/stock";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("stock per material", () => {
  it("sums locations and keeps the oldest as-of", () => {
    const totals = stockByMaterial([
      {
        materialId: "a",
        qtyOnHand: 10,
        qtyAllocated: 2,
        asOf: d("2026-11-02"),
      },
      { materialId: "a", qtyOnHand: 5, qtyAllocated: 0, asOf: d("2026-11-01") },
      { materialId: "b", qtyOnHand: 1, qtyAllocated: 0, asOf: d("2026-11-02") },
    ]);
    expect(totals.get("a")).toEqual({
      onHand: 15,
      allocated: 2,
      asOf: d("2026-11-01"),
    });
    expect(totals.get("b")?.onHand).toBe(1);
  });
});

describe("incoming purchase orders", () => {
  it("lists what is still to come, soonest first", () => {
    const incoming = incomingByMaterial([
      {
        materialId: "a",
        poNo: "P2",
        qtyOrdered: 10,
        qtyReceived: 0,
        dueDate: d("2026-11-10"),
      },
      {
        materialId: "a",
        poNo: "P1",
        qtyOrdered: 10,
        qtyReceived: 4,
        dueDate: d("2026-11-05"),
      },
      {
        materialId: "a",
        poNo: "P3",
        qtyOrdered: 5,
        qtyReceived: 5,
        dueDate: d("2026-11-01"),
      },
      {
        materialId: null,
        poNo: "P4",
        qtyOrdered: 1,
        qtyReceived: 0,
        dueDate: d("2026-11-01"),
      },
    ]);
    expect(incoming.get("a")).toEqual([
      { poNo: "P1", qty: 6, dueDate: d("2026-11-05") },
      { poNo: "P2", qty: 10, dueDate: d("2026-11-10") },
    ]);
    expect(incoming.size).toBe(1);
  });

  it("never reports negative quantities", () => {
    expect(remaining({ qtyOrdered: 5, qtyReceived: 7 })).toBe(0);
  });

  it("calls a line late only after its due day", () => {
    const now = new Date("2026-11-05T22:00:00Z");
    expect(isLate(d("2026-11-05"), now)).toBe(false);
    expect(isLate(d("2026-11-04"), now)).toBe(true);
  });
});
