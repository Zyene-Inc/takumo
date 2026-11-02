import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { readDrawing } from "@/lib/quotes/drawing";
import type { DrawingReading } from "@/lib/quotes/types";
import { readAnswerKey } from "./partners/answer-key";
import {
  type DrawingScore,
  scoreDrawing,
  summarizeDrawings,
} from "./partners/drawings";

// Drawing reading against the design partners' answer keys (F2.2
// acceptance). Uses the same evals/partners/<shop>/ folders as
// partners.eval.ts: the PDF and image files of each quote are read as
// drawings and compared with the key's material, rev, finish and (optional)
// tightest_tolerance columns.
//
// Costs money (the model reads every sheet). Without EVAL_CONFIRM=yes it only
// counts the drawings and prints what a run would cost.
//   pnpm --filter app eval:drawings
//   EVAL_CONFIRM=yes pnpm --filter app eval:drawings

const DIR = path.resolve(import.meta.dirname, "partners");
const RESULTS = path.resolve(import.meta.dirname, "results");
const CONFIRMED = process.env.EVAL_CONFIRM === "yes";
// A planning figure for the confirmation prompt, not a bill.
const USD_PER_DRAWING = 0.03;

const MEDIA: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const mediaType = (name: string) =>
  MEDIA[name.slice(name.lastIndexOf(".")).toLowerCase()] ?? null;

const shops = existsSync(DIR)
  ? readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => !process.env.PARTNER || d.name === process.env.PARTNER)
      .flatMap((d) => {
        const dir = path.join(DIR, d.name);
        const workbook = path.join(dir, "answer-key.xlsx");
        if (!existsSync(workbook)) {
          return [];
        }
        const filesDir = path.join(dir, "files");
        const files = existsSync(filesDir) ? readdirSync(filesDir) : [];
        const { key } = readAnswerKey(
          new Uint8Array(readFileSync(workbook)),
          files
        );
        return key ? [{ slug: d.name, dir, key }] : [];
      })
  : [];

const drawingsOf = (files: string[]) =>
  files.filter((f) => mediaType(f) !== null);

type Shop = (typeof shops)[number];
type Scored = DrawingScore & { quote: string; shop: string };

/** Read a quote's drawings and score each of its lines. */
const scoreQuote = async (
  shop: Shop,
  quote: Shop["key"]["quotes"][number]
): Promise<Scored[]> => {
  const readings: DrawingReading[] = [];
  for (const name of drawingsOf(quote.files)) {
    const bytes = new Uint8Array(
      readFileSync(path.join(shop.dir, "files", name))
    );
    readings.push(
      ...(await readDrawing(shop.key.orgId, {
        id: name,
        name,
        mediaType: mediaType(name) ?? "application/pdf",
        data: bytes,
      }))
    );
  }
  return quote.lines.map((line) => ({
    shop: shop.slug,
    quote: quote.id,
    ...scoreDrawing(line, readings),
  }));
};

describe("drawing reading", () => {
  test("what a run would cost", () => {
    const n = shops.reduce(
      (sum, s) =>
        sum + s.key.quotes.reduce((m, q) => m + drawingsOf(q.files).length, 0),
      0
    );
    console.log(
      `${n} drawing files: about $${(n * USD_PER_DRAWING).toFixed(2)} of AI.${
        CONFIRMED ? "" : " Nothing was run: set EVAL_CONFIRM=yes to run them."
      }`
    );
  });

  test.runIf(CONFIRMED)(
    "material, rev and finish ≥90%, tightest tolerance ≥80%, nothing silently wrong",
    async () => {
      const scores: Scored[] = [];
      for (const shop of shops) {
        for (const quote of shop.key.quotes) {
          scores.push(...(await scoreQuote(shop, quote)));
        }
      }
      const summary = summarizeDrawings(scores);
      for (const [field, f] of Object.entries(summary.fields)) {
        console.log(
          `${f.passes || f.of === 0 ? "✓" : "✗"} ${field}: ${f.n}/${f.of} (target ${Math.round(f.target * 100)}%)`
        );
      }
      for (const s of summary.silentlyWrong) {
        console.log(`✗ silently wrong ${s.field} on ${s.partNo}: "${s.read}"`);
      }
      mkdirSync(RESULTS, { recursive: true });
      writeFileSync(
        path.join(
          RESULTS,
          `drawings-${new Date().toISOString().slice(0, 10)}.json`
        ),
        JSON.stringify({ summary, scores }, null, 2)
      );
      expect(summary.passes).toBe(true);
    },
    30 * 60_000
  );
});
