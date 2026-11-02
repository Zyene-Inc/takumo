import { describe, expect, it } from "vitest";
import { erpEntryText } from "../lib/quotes/erp-entry";

describe("a won quote laid out for the ERP", () => {
  it("lists every field someone types into the ERP", () => {
    const text = erpEntryText({
      customer: "Cobalt Medical",
      partNo: "CM-1042",
      rev: "C",
      description: "Mounting bracket",
      qty: 200,
      unitPrice: 19.75,
      dueDate: "2026-12-15",
      quoteNo: "Q-0042",
    });
    expect(text).toBe(
      [
        "Customer: Cobalt Medical",
        "Part: CM-1042 rev C",
        "Description: Mounting bracket",
        "Quantity: 200",
        "Unit price: $19.75",
        "Total: $3,950.00",
        "Due date: 2026-12-15",
        "Quote: Q-0042",
      ].join("\n")
    );
  });

  it("leaves out what isn't known", () => {
    const text = erpEntryText({
      customer: null,
      partNo: "P-1",
      rev: null,
      description: null,
      qty: 1,
      unitPrice: 5,
      dueDate: "2026-12-01",
      quoteNo: "Q-1",
    });
    expect(text).toContain("Customer: (not set)");
    expect(text).toContain("Part: P-1\n");
    expect(text).not.toContain("Description");
  });
});
