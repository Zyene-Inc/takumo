// @vitest-environment node
// The Company Knowledge Library's small rules, without a database: how
// sizes, dates and file types read, what the browser refuses before sending
// (the same rules as the server), and that a permanent delete is never
// called complete while its files are still being removed.
import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../app/(authenticated)/knowledge/actions", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));

const format = await import("../lib/library/format");
const { localProblem } = await import(
  "../app/(authenticated)/library/components/upload"
);
const { checkDocumentFile } = await import("../lib/library/files");

describe("format", () => {
  test.each([
    [null, "—"],
    [512, "512 B"],
    [2048, "2 KB"],
    [1_572_864, "1.5 MB"],
    [20 * 1024 * 1024, "20 MB"],
  ])("%s bytes reads %s", (bytes, text) => {
    expect(format.fileSize(bytes)).toBe(text);
  });

  test("file types come from the stored media type, else the name", () => {
    expect(format.fileKind("application/pdf")).toBe("PDF");
    expect(
      format.fileKind(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      )
    ).toBe("Word");
    expect(format.fileKind(null, "setup.md")).toBe("MD");
    expect(format.fileKind(null, null)).toBe("Document");
  });

  test("only PDFs and images are shown as files; everything else as text", () => {
    expect(format.previewKind("application/pdf")).toBe("pdf");
    expect(format.previewKind("image/png")).toBe("image");
    expect(format.previewKind("text/csv")).toBe("text");
    expect(format.previewKind(null)).toBe("text");
    // Not SVG (it can carry scripts) or other image types: shown as text.
    expect(format.previewKind("image/svg+xml")).toBe("text");
    expect(format.PREVIEW_TYPES.has("image/svg+xml")).toBe(false);
    // In-page previews stay under what a response may carry on Vercel.
    expect(format.PREVIEW_MAX_BYTES).toBeLessThan(4.5 * 1024 * 1024);
  });

  test("the Trash says who moved a document there, and why Takumo did", () => {
    const deletedAt = new Date("2026-11-07T10:00:00Z");
    expect(
      format.trashNote({
        current: null,
        deletedAt,
        deletedBy: null,
        removerName: "Takumo",
      })
    ).toBe("Moved to the Trash by Takumo on Nov 7, 2026: it couldn't be read.");
    expect(
      format.trashNote({
        current: { number: 1 },
        deletedAt,
        deletedBy: "user_pat",
        removerName: "Pat Planner",
      })
    ).toBe("Moved to the Trash by Pat Planner on Nov 7, 2026.");
    expect(
      format.trashNote({
        current: null,
        deletedAt: null,
        deletedBy: null,
        removerName: null,
      })
    ).toBe("");
  });

  test("dates are the same on the server and in the browser (UTC)", () => {
    const date = new Date("2026-11-07T23:30:00Z");
    expect(format.shortDate(date)).toBe("Nov 7, 2026");
    expect(format.dateTime(date)).toBe("Nov 7, 2026, 11:30 PM UTC");
  });

  test("a permanent delete isn't called complete while files remain", () => {
    expect(format.purgedMessage("SOP-1", true)).toBe(
      "SOP-1 was deleted permanently."
    );
    expect(format.purgedMessage("SOP-1", false)).toContain(
      "still being removed"
    );
    expect(format.purgedMessage("SOP-1", false)).not.toContain("permanently");
  });
});

describe("files refused before sending", () => {
  test.each([
    ["drawing.dwg", 10, "Takumo reads"],
    ["empty.pdf", 0, "That file is empty."],
    ["huge.pdf", 20 * 1024 * 1024 + 1, "Files can be up to 20 MB."],
  ])("%s", (name, size, message) => {
    expect(localProblem({ name, size })).toContain(message);
  });

  test("the browser and the server agree on type and size", () => {
    for (const name of ["a.pdf", "b.DOCX", "c.png", "d.csv"]) {
      expect(localProblem({ name, size: 100 })).toBeNull();
    }
    // The server refuses the same over-size file.
    expect(
      checkDocumentFile("big.txt", new Uint8Array(20 * 1024 * 1024 + 1)).ok
    ).toBe(false);
  });
});
