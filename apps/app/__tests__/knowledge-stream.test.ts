// @vitest-environment node
// What an upload's step stream says when storing fails: a name already taken
// and Takumo's own processing problems explain themselves; anything else
// (which could name the AI provider) doesn't.
import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
// No database in a unit test: the stream never stores anything.
vi.mock("@repo/database", () => ({ database: {}, forOrg: vi.fn() }));
// Document search checks who is asking (lib/library/viewer.ts); not used here.
vi.mock("@repo/auth/server", () => ({ auth: vi.fn(), shopRole: vi.fn() }));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { DocumentExistsError } = await import("../lib/knowledge/documents");
const { streamSteps } = await import("../lib/knowledge/stream");
const { DocumentProblem, OriginalNotStoredError } = await import(
  "../lib/library/problems"
);

const lastEvent = async (error: unknown) => {
  const response = streamSteps(() => Promise.reject(error));
  const lines = (await response.text()).split("\n").filter(Boolean);
  return JSON.parse(lines.at(-1) ?? "{}");
};

describe("upload stream errors", () => {
  test("a name already taken says why (uploading never replaces)", async () => {
    expect(await lastEvent(new DocumentExistsError("SOP-12"))).toEqual({
      type: "error",
      error:
        "There's already a document called SOP-12. Rename your file and upload it again.",
    });
  });

  test("Takumo's own processing and storage problems say what happened", async () => {
    expect(
      await lastEvent(
        new DocumentProblem("No text found in that file.", { permanent: true })
      )
    ).toEqual({ type: "error", error: "No text found in that file." });
    expect(await lastEvent(new OriginalNotStoredError())).toEqual({
      type: "error",
      error: "Couldn't save the file just now. Try again in a minute.",
    });
  });

  test("other errors get the plain message", async () => {
    expect(await lastEvent(new Error("Provider X: rate limited"))).toEqual({
      type: "error",
      error: "Couldn't read that file. Try again, or upload it as a PDF.",
    });
  });
});
