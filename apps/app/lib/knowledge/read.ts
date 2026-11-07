import "server-only";

import { generateText, Output } from "@repo/ai";
import { models } from "@repo/ai/lib/models";
import { z } from "zod";
import { recordFailedUsage, recordUsage } from "../ai-usage";
import { htmlTablesToMarkdown, type PageText } from "./chunk";
import { extractPages } from "./extract";
import { IMAGE_TYPES } from "./types";

/** A PDF page with less text than this is a scan or a photo of paper. */
const MIN_PAGE_TEXT = 40;
/** Pages per recognition call, and calls at once. */
const PAGES_PER_CALL = 5;
const PARALLEL_CALLS = 3;

const IMAGE_MEDIA: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const RECOGNIZE = `Transcribe these pages from a machine shop's document into Markdown, exactly as written.
- Headings as #, ##, ###; keep lists and numbering.
- Tables as HTML <table> with a <th> header row; keep every row and cell, with rowspan/colspan for merged cells. Never summarise a table.
- Handwriting: transcribe it; write [?] for a word you can't read.
- Drawings, photos and figures: one line [FIGURE: what it shows], listing any dimensions, tolerances, GD&T, notes and title-block fields (part number, revision, material, finish) you can read.
- Add nothing that isn't on the page. A blank page is an empty string.
Return one entry per page, in order.`;

const pagesSchema = z.object({
  pages: z.array(
    z.object({
      page: z
        .number()
        .int()
        .describe("The page's position in this file, from 1"),
      markdown: z.string(),
    })
  ),
});

/** Gemini reads page images (scans, photos) into Markdown, one entry per page. */
const recognize = async (
  orgId: string,
  data: Uint8Array,
  mediaType: string,
  count: number
) => {
  try {
    const { output, usage, finalStep } = await generateText({
      model: models.chat,
      output: Output.object({ schema: pagesSchema }),
      messages: [
        {
          role: "user",
          content: [
            { type: "file", data, mediaType },
            {
              type: "text",
              text: `${RECOGNIZE}\nThis file has ${count} page${count === 1 ? "" : "s"}.`,
            },
          ],
        },
      ],
    });
    await recordUsage(orgId, "doc_read", finalStep.response.modelId, usage);
    const byPage = new Map(
      output.pages.map((p) => [p.page, htmlTablesToMarkdown(p.markdown)])
    );
    return Array.from({ length: count }, (_, i) => byPage.get(i + 1) ?? "");
  } catch (error) {
    await recordFailedUsage(orgId, "doc_read", error);
    throw error;
  }
};

/** Copy some pages of a PDF into a new, smaller PDF. */
export const pdfPages = async (bytes: Uint8Array, pages: number[]) => {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const copied = await out.copyPages(
    source,
    pages.map((p) => p - 1)
  );
  for (const page of copied) {
    out.addPage(page);
  }
  return out.save();
};

export const inGroups = <T>(items: T[], size: number) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size)
  );

export interface ReadOptions {
  /** Scanned pages already read by an earlier run, by page number: not read again. */
  known?: Map<number, string>;
  onProgress?: (done: number, total: number) => void;
  /**
   * Called after each batch of scanned pages is read, before the next one,
   * so a run that stops resumes from there (Knowledge Hub processing).
   */
  onRecognized?: (pages: PageText[]) => Promise<void>;
}

interface ReadResult {
  pages: PageText[];
  /** Pages read from an image (scans, photos) rather than a text layer. */
  recognized: number;
}

/**
 * A document's text, page by page. Text PDFs, Word and text files are read
 * directly; scanned pages and photos are read by Gemini, tables included.
 */
export const readDocument = async (
  orgId: string,
  name: string,
  bytes: Uint8Array,
  options: ReadOptions = {}
): Promise<ReadResult> => {
  const { known, onProgress, onRecognized } = options;
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  if ((IMAGE_TYPES as readonly string[]).includes(ext)) {
    const saved = known?.get(1);
    if (saved !== undefined) {
      return { pages: [{ page: 1, text: saved }], recognized: 1 };
    }
    const [markdown] = await recognize(orgId, bytes, IMAGE_MEDIA[ext], 1);
    await onRecognized?.([{ page: 1, text: markdown }]);
    return { pages: [{ page: 1, text: markdown }], recognized: 1 };
  }
  const pages = await extractPages(name, bytes);
  if (ext !== ".pdf") {
    return { pages, recognized: 0 };
  }
  const scanned = pages
    .filter((p) => p.text.trim().length < MIN_PAGE_TEXT)
    .map((p) => p.page as number);
  if (scanned.length === 0) {
    return { pages, recognized: 0 };
  }
  for (const page of scanned) {
    const saved = known?.get(page);
    if (saved !== undefined) {
      pages[page - 1] = { page, text: saved };
    }
  }
  const toRead = scanned.filter((page) => !known?.has(page));
  const groups = inGroups(toRead, PAGES_PER_CALL);
  let done = scanned.length - toRead.length;
  for (const batch of inGroups(groups, PARALLEL_CALLS)) {
    await Promise.all(
      batch.map(async (group) => {
        const texts = await recognize(
          orgId,
          await pdfPages(bytes, group),
          "application/pdf",
          group.length
        );
        group.forEach((page, i) => {
          pages[page - 1] = { page, text: texts[i] };
        });
        await onRecognized?.(group.map((page) => pages[page - 1]));
        done += group.length;
        onProgress?.(done, scanned.length);
      })
    );
  }
  return { pages, recognized: scanned.length };
};
