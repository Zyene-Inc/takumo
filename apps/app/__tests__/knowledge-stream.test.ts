// @vitest-environment node
// What an upload's step stream says when storing fails: a refused replacement
// explains itself; anything else (which could name the AI provider) doesn't.
import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
// No database in a unit test: the stream never stores anything.
vi.mock("@repo/database", () => ({ database: {}, forOrg: vi.fn() }));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { DocumentExistsError } = await import("../lib/knowledge/documents");
const { streamSteps } = await import("../lib/knowledge/stream");

const lastEvent = async (error: unknown) => {
  const response = streamSteps(() => Promise.reject(error));
  const lines = (await response.text()).split("\n").filter(Boolean);
  return JSON.parse(lines.at(-1) ?? "{}");
};

describe("upload stream errors", () => {
  test("a refused replacement says why", async () => {
    expect(await lastEvent(new DocumentExistsError("SOP-12"))).toEqual({
      type: "error",
      error:
        "There's already a document called SOP-12. Rename your file, or ask an admin to replace it.",
    });
  });

  test("other errors get the plain message", async () => {
    expect(await lastEvent(new Error("Provider X: rate limited"))).toEqual({
      type: "error",
      error: "Couldn't read that file. Try again, or upload it as a PDF.",
    });
  });
});
