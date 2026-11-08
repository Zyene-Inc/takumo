// @vitest-environment node
// Reading scanned pages so a stopped run can resume (Knowledge Hub phase 2):
// pages already read aren't sent to the AI again, and each batch is handed
// over to be saved before the next one is read. The AI is mocked; the PDF
// is real (12 pages, each as wide as 100 + its page number, so the mock can
// tell which pages it was sent).
import { PDFDocument } from "pdf-lib";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../lib/ai-usage", () => ({
  recordUsage: vi.fn(),
  recordFailedUsage: vi.fn(),
}));
// Page 1 has a text layer; pages 2-12 are scans.
vi.mock("../lib/knowledge/extract", () => ({
  extractPages: async () =>
    Array.from({ length: 12 }, (_, i) => ({
      page: i + 1,
      text: i === 0 ? "A cover page with a real text layer on it." : "",
    })),
}));
const generateText = vi.hoisted(() => vi.fn());
vi.mock("@repo/ai", () => ({
  generateText,
  Output: { object: () => ({}) },
}));
vi.mock("@repo/ai/lib/models", () => ({ models: { chat: "model" } }));

const { readDocument } = await import("../lib/knowledge/read");

const twelvePages = async () => {
  const doc = await PDFDocument.create();
  for (let page = 1; page <= 12; page += 1) {
    doc.addPage([100 + page, 200]);
  }
  return doc.save();
};

/** Pages the AI was sent, in calls. */
const sent: number[][] = [];

/** The AI "reads" each page as "OCR <n>"; `failAfter` calls succeed, then it fails. */
const ai = (failAfter = Number.POSITIVE_INFINITY) => {
  let calls = 0;
  generateText.mockImplementation(
    async ({
      messages,
    }: {
      messages: { content: { data?: Uint8Array }[] }[];
    }) => {
      calls += 1;
      if (calls > failAfter) {
        throw new Error("provider timeout");
      }
      const pdf = await PDFDocument.load(
        messages[0].content[0].data ?? new Uint8Array()
      );
      const pages = pdf.getPages().map((p) => p.getWidth() - 100);
      sent.push(pages);
      return {
        output: {
          pages: pages.map((p, i) => ({ page: i + 1, markdown: `OCR ${p}` })),
        },
        usage: {},
        finalStep: { response: { modelId: "m" } },
      };
    }
  );
};

describe("resumable reading", () => {
  let bytes: Uint8Array;

  beforeEach(async () => {
    generateText.mockReset();
    sent.length = 0;
    bytes = await twelvePages();
  });

  test("without saved pages, every scan is read and handed over batch by batch", async () => {
    ai();
    const saved: (number | null)[][] = [];
    const result = await readDocument("org", "scan.pdf", bytes, {
      onRecognized: async (pages) => {
        saved.push(pages.map((p) => p.page));
      },
    });
    expect(result.recognized).toBe(11);
    expect(result.pages[0].text).toContain("cover page");
    expect(result.pages[5]).toEqual({ page: 6, text: "OCR 6" });
    expect(saved.flat().sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    // Five pages per call, each batch handed over as it's read.
    expect(saved.map((s) => s.length).sort()).toEqual([1, 5, 5]);
  });

  test("pages read before are reused, not sent to the AI again", async () => {
    ai();
    const known = new Map(
      [2, 3, 4, 5, 6].map((p) => [p, `saved ${p}`] as const)
    );
    const progress: number[] = [];
    const result = await readDocument("org", "scan.pdf", bytes, {
      known,
      onProgress: (done) => progress.push(done),
    });
    expect(sent.flat().sort((a, b) => a - b)).toEqual([7, 8, 9, 10, 11, 12]);
    expect(result.pages[1]).toEqual({ page: 2, text: "saved 2" });
    expect(result.pages[6]).toEqual({ page: 7, text: "OCR 7" });
    expect(result.recognized).toBe(11);
    // Progress counts the pages already read.
    expect(Math.max(...progress)).toBe(11);
  });

  test("when a batch fails the read stops, and the batches read before it were handed over", async () => {
    ai(1);
    const saved: (number | null)[] = [];
    await expect(
      readDocument("org", "scan.pdf", bytes, {
        onRecognized: async (pages) => {
          saved.push(...pages.map((p) => p.page));
        },
      })
    ).rejects.toThrow("provider timeout");
    expect(saved).toEqual(sent[0]);
    expect(saved.length).toBeGreaterThan(0);
  });

  test("an image already read isn't read again", async () => {
    ai();
    const result = await readDocument("org", "photo.png", new Uint8Array(), {
      known: new Map([[1, "saved photo"]]),
    });
    expect(result).toEqual({
      pages: [{ page: 1, text: "saved photo" }],
      recognized: 1,
    });
    expect(generateText).not.toHaveBeenCalled();
  });
});
