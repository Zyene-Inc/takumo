import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateText } from "@repo/ai";
import { models } from "@repo/ai/lib/models";
import { costUsd } from "@repo/ai/lib/pricing";
import { database, forOrg } from "@repo/database";
import type { ScheduleResponse } from "@repo/engine-client/types";
import { afterAll, beforeAll, describe, test } from "vitest";
import { agentSettings } from "@/lib/agent/agent";
import { saveDocument } from "@/lib/knowledge/documents";
import { estimateForPart } from "@/lib/quotes/estimate";
import { CAPACITY_CHECK, PLAN, replan } from "@/lib/schedule/plan";
import { EVAL_TODAY, type EvalContext, GOLDEN, QUOTE_CASES } from "./golden";
import { grade } from "./grade";

// The demo shop (seed/acme-precision). Needs the database, the scheduling
// engine (pnpm dev:engine) and ANTHROPIC_API_KEY.
const ORG_ID = process.env.EVAL_ORG_ID ?? "org_01M64Y2YX6Q7517K5KJR1185CA";
const DOCS_DIR = path.resolve(
  import.meta.dirname,
  "../../../seed/acme-precision/docs"
);
const RESULTS = path.resolve(import.meta.dirname, "results");

interface Outcome {
  answer: string;
  cited: string[];
  failures: string[];
  q: string;
  seconds: number;
  tools: string[];
  uncitedLines: string[];
  unverified: string[];
}

const outcomes: Outcome[] = [];
// EVAL_MODEL=sonnet runs the questions on Sonnet (cheaper, for day-to-day
// checks); the default is the agent's own model (Opus), as in production.
const EVAL_MODEL = process.env.EVAL_MODEL === "sonnet" ? models.chat : null;
let spentUsd = 0;
const ctx = {} as EvalContext;
let started = new Date();

beforeAll(async () => {
  started = new Date();
  const db = forOrg(database, ORG_ID);
  const [orders, quotes, machines] = await Promise.all([
    db.order.count({ where: { status: { in: ["open", "in_progress"] } } }),
    db.quote.count(),
    db.workCenter.count(),
  ]);
  if (!(orders === 6 && quotes === 8 && machines === 5)) {
    throw new Error(
      `The eval shop doesn't match seed/acme-precision (${orders} open orders, ${quotes} quotes, ${machines} machines; expected 6, 8, 5).`
    );
  }
  // The demo documents (re-uploading replaces them).
  for (const file of readdirSync(DOCS_DIR)) {
    const text = readFileSync(path.join(DOCS_DIR, file), "utf8");
    await saveDocument(ORG_ID, file, [{ page: 1, text }]);
  }
  const planned = await replan(ORG_ID, null, EVAL_TODAY);
  if (!planned.ok) {
    throw new Error(
      `Couldn't build the plan: ${planned.error} (is the engine running?)`
    );
  }
  ctx.plan = planned.plan.output as ScheduleResponse;
  ctx.estimates = {};
  for (const [key, c] of Object.entries(QUOTE_CASES)) {
    const part = await db.part.findFirst({ where: { partNo: c.partNo } });
    const estimate = part
      ? await estimateForPart(ORG_ID, part.id, {
          qtys: [...c.qtys],
          customer: c.customer,
          requestedDate: null,
          targetMargin: null,
          today: EVAL_TODAY,
        })
      : null;
    if (!estimate?.ok) {
      throw new Error(
        `Couldn't estimate ${c.partNo} for the quoting questions.`
      );
    }
    ctx.estimates[key] = estimate.response;
  }
}, 300_000);

afterAll(async () => {
  // Leave the demo shop as it was: remove the runs the eval created.
  await database.scheduleRun.deleteMany({
    where: {
      orgId: ORG_ID,
      createdBy: null,
      createdAt: { gte: started },
      objective: { in: [PLAN, CAPACITY_CHECK] },
    },
  });
  await database.job.deleteMany({
    where: { orgId: ORG_ID, actualStart: null },
  });

  mkdirSync(RESULTS, { recursive: true });
  const passed = outcomes.filter((o) => o.failures.length === 0).length;
  const report = JSON.stringify(
    { date: new Date().toISOString(), passed, total: GOLDEN.length, outcomes },
    null,
    2
  );
  writeFileSync(path.join(RESULTS, "latest.json"), report);
  writeFileSync(path.join(RESULTS, `run-${Date.now()}.json`), report);
  const lines = outcomes
    .sort(
      (a, b) =>
        GOLDEN.findIndex((g) => g.q === a.q) -
        GOLDEN.findIndex((g) => g.q === b.q)
    )
    .map(
      (o) =>
        `${o.failures.length ? "✗" : "✓"} ${o.q}${o.failures.length ? `\n    ${o.failures.join("\n    ")}` : ""}`
    );
  process.stdout.write(
    `\nAsk Takumo golden questions: ${passed}/${GOLDEN.length} passed (Claude cost about $${spentUsd.toFixed(2)})\n${lines.join("\n")}\n` +
      `Details: ${path.relative(process.cwd(), path.join(RESULTS, "latest.json"))}\n`
  );
});

describe("Ask Takumo golden questions", () => {
  test.concurrent.for(GOLDEN.map((g) => [g.q, g] as const))("%s", async ([
    ,
    golden,
  ], { expect }) => {
    const begin = Date.now();
    const settings = await agentSettings({
      orgId: ORG_ID,
      userId: null,
      today: EVAL_TODAY,
    });
    const result = await generateText({
      ...settings,
      ...(EVAL_MODEL ? { model: EVAL_MODEL } : {}),
      prompt: golden.q,
    });
    spentUsd += costUsd(result.response.modelId, result.totalUsage) ?? 0;
    const graded = grade(golden, result, ctx);
    outcomes.push({
      q: golden.q,
      answer: result.text,
      tools: graded.calls,
      cited: graded.cited,
      unverified: graded.unverified,
      uncitedLines: graded.uncitedLines,
      seconds: Math.round((Date.now() - begin) / 100) / 10,
      failures: graded.failures,
    });
    expect(graded.failures).toEqual([]);
  });
});
