import { beforeEach, describe, expect, test, vi } from "vitest";

const generateText = vi.hoisted(() => vi.fn());
const ai = vi.hoisted(() => ({ configured: true }));

vi.mock("server-only", () => ({}));
vi.mock("@repo/ai", () => ({
  generateText,
  NoObjectGeneratedError: { isInstance: () => false },
  Output: { object: (options: unknown) => options },
}));
vi.mock("@repo/ai/lib/models", () => ({
  models: { extract: "haiku" },
  get canGenerate() {
    return ai.configured;
  },
}));
vi.mock("@repo/observability/log", () => ({ log: { warn: vi.fn() } }));

const { suggestMappingWithAi } = await import("../ai-mapping");

const headers = ["WO", "Item", "Pcs", "Need By", "Notes"];
const rows = [
  { WO: "W-1", Item: "P-1", Pcs: 10, "Need By": "2026-11-20", Notes: "" },
];

describe("suggestMappingWithAi", () => {
  beforeEach(() => {
    generateText.mockReset();
    ai.configured = true;
  });

  test("uses the model's mapping and drops columns that aren't in the file", async () => {
    generateText.mockResolvedValue({
      output: {
        entity: "orders",
        columns: [
          { field: "orderNo", column: "WO", confidence: 0.95, timeUnit: null },
          { field: "partNo", column: "Item", confidence: 0.9, timeUnit: null },
          { field: "qty", column: "Pcs", confidence: 0.9, timeUnit: null },
          {
            field: "dueDate",
            column: "Need By",
            confidence: 0.85,
            timeUnit: null,
          },
          {
            field: "customer",
            column: "Client",
            confidence: 0.5,
            timeUnit: null,
          },
        ],
        notes: ["Need By is the due date"],
      },
    });
    const mapping = await suggestMappingWithAi({
      fileName: "jobs.xlsx",
      headers,
      rows,
    });
    expect(mapping.source).toBe("ai");
    expect(mapping.entity).toBe("orders");
    expect(mapping.columns).toMatchObject({
      orderNo: "WO",
      partNo: "Item",
      qty: "Pcs",
      dueDate: "Need By",
      customer: null, // "Client" is not a header
    });
    expect(mapping.notes).toEqual(["Need By is the due date"]);
  });

  test("reports what the call used, and skips the model when AI is paused", async () => {
    const usage = { inputTokens: 900, outputTokens: 120 };
    generateText.mockResolvedValue({
      output: { entity: "orders", columns: [], notes: [] },
      usage,
      finalStep: { response: { modelId: "haiku" } },
    });
    const onUsage = vi.fn(async () => undefined);
    await suggestMappingWithAi({ fileName: "a.csv", headers, rows, onUsage });
    expect(onUsage).toHaveBeenCalledWith("haiku", usage);

    generateText.mockClear();
    const offline = await suggestMappingWithAi({
      fileName: "a.csv",
      headers,
      rows,
      useAi: false,
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(offline.source).toBe("heuristic");
  });

  test("keeps the sheet type the user chose", async () => {
    generateText.mockResolvedValue({
      output: { entity: "parts", columns: [], notes: [] },
    });
    const mapping = await suggestMappingWithAi({
      fileName: "jobs.xlsx",
      headers,
      rows,
      entity: "orders",
    });
    expect(mapping.entity).toBe("orders");
  });

  test("falls back to the offline matcher when the call fails", async () => {
    generateText.mockRejectedValue(new Error("overloaded"));
    const mapping = await suggestMappingWithAi({
      fileName: "orders.csv",
      headers: ["Order No", "Part Number", "Qty", "Due Date"],
      rows: [],
    });
    expect(mapping.source).toBe("heuristic");
    expect(mapping.entity).toBe("orders");
    expect(mapping.columns.orderNo).toBe("Order No");
  });

  test("doesn't call the model without an API key", async () => {
    ai.configured = false;
    const mapping = await suggestMappingWithAi({
      fileName: "x.csv",
      headers,
      rows,
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(mapping.source).toBe("heuristic");
  });
});
