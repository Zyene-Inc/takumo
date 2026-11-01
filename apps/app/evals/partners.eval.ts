import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { database, forOrg } from "@repo/database";
import { afterAll, describe, expect, test } from "vitest";
import { estimateLine } from "@/lib/quotes/estimate";
import { intakeRfq } from "@/lib/quotes/intake";
import { type RfqText, readRfqFile } from "@/lib/quotes/read";
import type { LineDraft } from "@/lib/quotes/types";
import { loadRfqView } from "@/lib/quotes/view";
import { runCapacityCheck } from "@/lib/schedule/check";
import {
  type AnswerKey,
  type FeasibilityCase,
  type QuoteCase,
  readAnswerKey,
} from "./partners/answer-key";
import {
  compareFeasibility,
  compareLine,
  type DraftedLine,
  type FeasibilityResult,
  type LineResult,
  summarize,
} from "./partners/compare";

// Design partners' real RFQs and delivery questions against Takumo
// (docs/PRODUCT-PLAN.md F0.2). Each shop's answer key lives in
// evals/partners/<shop>/ (answer-key.xlsx + files/), which git ignores: it's
// customer data. Runs in the shop's own Takumo organization and removes the
// RFQs and checks it made.
//
// Costs money (the model reads every RFQ). Without EVAL_CONFIRM=yes it only
// checks the answer keys and prints what a run would cost.
//   pnpm --filter app eval:partners                     # check only, free
//   EVAL_CONFIRM=yes pnpm --filter app eval:partners    # run every shop
//   EVAL_CONFIRM=yes PARTNER=acme pnpm --filter app eval:partners

const DIR = path.resolve(import.meta.dirname, "partners");
const RESULTS = path.resolve(import.meta.dirname, "results");
const EVAL_USER = "eval:partners";
const CONFIRMED = process.env.EVAL_CONFIRM === "yes";
// Measured on the demo shop: reading an RFQ, proposing routings for new parts
// and pricing. A planning figure for the confirmation prompt, not a bill.
const USD_PER_QUOTE = 0.08;
const USD_PER_CHECK = 0;

interface Partner {
  dir: string;
  files: string[];
  key: AnswerKey | null;
  problems: string[];
  slug: string;
}

const partners: Partner[] = existsSync(DIR)
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
        const { key, problems } = readAnswerKey(
          new Uint8Array(readFileSync(workbook)),
          files
        );
        return [
          {
            slug: d.name,
            dir,
            files,
            key,
            problems: problems.map(
              (p) => `${p.sheet}${p.row ? ` row ${p.row}` : ""}: ${p.message}`
            ),
          },
        ];
      })
  : [];

const today = () => new Date().toISOString().slice(0, 10);

const commit = () => {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

/** Every file of an RFQ as one text: the first is the RFQ, the rest attachments. */
const readQuoteFiles = async (
  dir: string,
  quote: QuoteCase
): Promise<RfqText> => {
  const texts = await Promise.all(
    quote.files.map(async (name) => ({
      name,
      text: await readRfqFile(
        name,
        new Uint8Array(readFileSync(path.join(dir, "files", name)))
      ),
    }))
  );
  const [first, ...rest] = texts;
  return {
    ...first.text,
    body: [
      first.text.body,
      ...rest.map((r) => `[Attachment: ${r.name}]\n${r.text.body}`),
    ].join("\n\n"),
  };
};

const draftedLines = async (orgId: string, rfqId: string, asOf: string) => {
  const view = await loadRfqView(orgId, rfqId);
  const lines: DraftedLine[] = [];
  for (const line of view?.lines ?? []) {
    const estimate = await estimateLine(orgId, line.id, asOf);
    const draft = (estimate as { draft?: LineDraft }).draft;
    lines.push({
      partNo: line.part?.partNo ?? line.partNo,
      rev: line.part?.rev ?? line.rev,
      material: line.material?.name ?? line.materialText,
      finish: line.finish,
      qtys: line.qtys,
      breaks: (draft?.response.breaks ?? []).map((b) => ({
        qty: b.qty,
        unitPrice: b.unit_price,
        leadTimeDays: b.lead_time_days ?? null,
      })),
    });
  }
  return {
    lines,
    status: view?.status ?? "missing",
    error: view?.error ?? null,
  };
};

const findPart = async (orgId: string, c: FeasibilityCase) => {
  const parts = await forOrg(database, orgId).part.findMany({
    where: { partNo: { equals: c.partNo, mode: "insensitive" } },
    select: { id: true, rev: true },
  });
  return (
    parts.find((p) => c.rev && p.rev.toUpperCase() === c.rev.toUpperCase()) ??
    parts[0] ??
    null
  );
};

describe("design-partner answer keys", () => {
  test("every answer key reads cleanly", () => {
    for (const p of partners) {
      console.log(
        p.problems.length
          ? `✗ ${p.slug}: ${p.problems.length} problem(s)\n  ${p.problems.join("\n  ")}`
          : `✓ ${p.slug}: ${p.key?.quotes.length ?? 0} quotes (${p.key?.quotes.reduce((n, q) => n + q.lines.length, 0) ?? 0} lines), ${p.key?.feasibility.length ?? 0} delivery questions`
      );
    }
    if (partners.length === 0) {
      console.log(
        `No answer keys in ${DIR}. Copy docs/design-partners/answer-key-template.xlsx to evals/partners/<shop>/answer-key.xlsx and the RFQ files to evals/partners/<shop>/files/.`
      );
    }
    expect(partners.flatMap((p) => p.problems)).toEqual([]);
  });

  test("what a run would cost", () => {
    const quotes = partners.reduce(
      (n, p) => n + (p.key?.quotes.length ?? 0),
      0
    );
    const checks = partners.reduce(
      (n, p) => n + (p.key?.feasibility.length ?? 0),
      0
    );
    const usd = quotes * USD_PER_QUOTE + checks * USD_PER_CHECK;
    console.log(
      `${quotes} RFQs and ${checks} delivery questions: about $${usd.toFixed(2)} of AI.${
        CONFIRMED ? "" : " Nothing was run: set EVAL_CONFIRM=yes to run them."
      }`
    );
  });
});

type ScoredLine = LineResult & { quoteId: string; seconds: number };

/** Every RFQ through intake and pricing, scored against what was sent. */
const runQuotes = async (p: Partner, key: AnswerKey) => {
  const lines: ScoredLine[] = [];
  const runs: Record<string, unknown>[] = [];
  for (const quote of key.quotes) {
    const t0 = Date.now();
    const elapsed = () => Math.round((Date.now() - t0) / 1000);
    try {
      const text = await readQuoteFiles(p.dir, quote);
      const rfq = await intakeRfq(key.orgId, EVAL_USER, text, quote.files[0]);
      const drafted = await draftedLines(key.orgId, rfq.id, quote.receivedDate);
      const seconds = elapsed();
      for (const line of quote.lines) {
        lines.push({
          ...compareLine(line, drafted.lines),
          quoteId: quote.id,
          seconds,
        });
      }
      runs.push({
        quote: quote.id,
        status: drafted.status,
        error: drafted.error,
        seconds,
        drafted: drafted.lines,
      });
    } catch (error) {
      runs.push({ quote: quote.id, error: String(error) });
      for (const line of quote.lines) {
        lines.push({
          ...compareLine(line, []),
          quoteId: quote.id,
          seconds: elapsed(),
        });
      }
    }
  }
  return { lines, runs };
};

/** Every delivery question through the capacity check, against the planner. */
const runFeasibility = async (key: AnswerKey) => {
  const results: FeasibilityResult[] = [];
  for (const c of key.feasibility) {
    const part = await findPart(key.orgId, c);
    const answer = part
      ? await runCapacityCheck(key.orgId, EVAL_USER, today(), {
          partId: part.id,
          qty: c.qty,
          dueDate: c.requestedDate,
        })
      : null;
    results.push(
      compareFeasibility(
        c,
        answer?.ok
          ? {
              canTake: answer.result.can_take,
              date: answer.result.new_order?.completion_date ?? null,
            }
          : null,
        today()
      )
    );
  }
  return results;
};

const pct = (s: { n: number; of: number }) =>
  s.of ? `${s.n}/${s.of} (${Math.round((100 * s.n) / s.of)}%)` : "n/a";

/** Save the run as JSON and print the table the plan's targets are read from. */
const report = (
  p: Partner,
  key: AnswerKey,
  run: {
    costUsd: number;
    feasibility: FeasibilityResult[];
    lines: ScoredLine[];
    quotes: Record<string, unknown>[];
  }
) => {
  const summary = summarize(run.lines, run.feasibility);
  const result = {
    shop: key.shopName,
    slug: p.slug,
    ranAt: new Date().toISOString(),
    commit: commit(),
    baseline: key.baseline,
    summary,
    ...run,
  };
  mkdirSync(RESULTS, { recursive: true });
  const file = path.join(RESULTS, `partners-${p.slug}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  const median = summary.quotes.medianAbsPriceDiff;
  console.log(
    `\n${key.shopName}: ${result.commit ?? "uncommitted"}, $${run.costUsd.toFixed(2)} of AI`
  );
  console.table({
    "Lines found": pct(summary.quotes.linesFound),
    "Revision read": pct(summary.quotes.revRead),
    "Quantities read": pct(summary.quotes.qtysRead),
    "Material read": pct(summary.quotes.materialRead),
    "Finish read": pct(summary.quotes.finishRead),
    "Price within 5%": pct(summary.quotes.priceWithin5pct),
    "Lead time within 2 days": pct(summary.quotes.leadTimeWithin2Days),
    "Median price difference":
      median === null ? "n/a" : `${(median * 100).toFixed(1)}%`,
    "Delivery answers agree": pct(summary.feasibility.agrees),
    "Delivery cases older than 3 days": summary.feasibility.historical,
  });
  console.log(`Saved ${path.relative(process.cwd(), file)}`);
};

describe.skipIf(!CONFIRMED)(
  "design partners: real RFQs and delivery questions",
  () => {
    const started = new Date();

    afterAll(async () => {
      // Leave each shop as it was: the RFQs and checks this run made.
      for (const p of partners) {
        if (!p.key) {
          continue;
        }
        const db = forOrg(database, p.key.orgId);
        await db.rfq.deleteMany({ where: { createdBy: EVAL_USER } });
        await db.scheduleRun.deleteMany({ where: { createdBy: EVAL_USER } });
      }
    });

    for (const p of partners.filter((x) => x.key)) {
      const key = p.key as AnswerKey;
      test(`${p.slug}: quotes and delivery answers`, {
        timeout: 60 * 60_000,
      }, async () => {
        const quotes = await runQuotes(p, key);
        const feasibility = await runFeasibility(key);
        const spend = await database.aiUsage.aggregate({
          where: { orgId: key.orgId, createdAt: { gte: started } },
          _sum: { costUsd: true },
        });
        report(p, key, {
          costUsd: Number(spend._sum.costUsd ?? 0),
          lines: quotes.lines,
          quotes: quotes.runs,
          feasibility,
        });
        // A report, not a gate: the numbers are read against the plan's targets.
        expect(quotes.lines.length).toBe(
          key.quotes.reduce((n, q) => n + q.lines.length, 0)
        );
      });
    }
  }
);
