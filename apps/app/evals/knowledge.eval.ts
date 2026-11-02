import { generateText } from "@repo/ai";
import { database, forOrg } from "@repo/database";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { agentSettings } from "@/lib/agent/agent";
import { collectSources, linkCitations } from "@/lib/agent/citations";
import { factLabel } from "@/lib/facts/attributes";
import { setupTrend, weeklyError } from "@/lib/facts/calibration";
import { approveFact, findSubject, proposeFact } from "@/lib/facts/facts";
import { saveNote } from "@/lib/facts/notes";
import {
  loadFinishedJobs,
  RECALIBRATION,
  recalibrate,
} from "@/lib/facts/recalibrate";
import { logOperation } from "@/lib/floor/log";
import { EVAL_TODAY } from "./golden";

// Tribal knowledge and calibration end to end on the demo shop
// (seed/acme-precision with its job history): notes become the right facts,
// a correction in chat waits for review, approval changes the model and keeps
// the history, recalibration finds what the job history says, and once the
// fix is approved the next week's setup error is lower. Needs the database
// and ANTHROPIC_API_KEY. Leaves the shop as it was.
const ORG_ID = process.env.EVAL_ORG_ID ?? "org_01M64Y2YX6Q7517K5KJR1185CA";
const USER = "eval:knowledge";
const NOW = new Date(`${EVAL_TODAY}T12:00:00Z`);
const DAY_MS = 86_400_000;

interface ExpectedFact {
  attribute: string;
  subject: RegExp;
  /** A number to match within 2%, or a pattern for a note. */
  value: number | RegExp;
}

const NOTES: { text: string; expect: ExpectedFact[] }[] = [
  {
    text: "Setup on the OKUMA for P-2001 is really two hours, not ninety minutes. The bar puller has to be reset every time.",
    expect: [
      { subject: /P-2001 rev C op 10/, attribute: "setupMin", value: 120 },
    ],
  },
  {
    text: "Heads up, the VF-4 has only been giving us about 85 percent since the spindle rebuild.",
    expect: [{ subject: /^HAAS-VF4$/, attribute: "efficiency", value: 0.85 }],
  },
  {
    text: "Our supplier says the 316 stainless bar is a ten day lead time now.",
    expect: [{ subject: /SS316 bar/, attribute: "leadTimeDays", value: 10 }],
  },
  {
    text: "P-3001 trays crack at the bend when the grain runs the wrong way. Always nest them with the grain running along the long side.",
    expect: [{ subject: /P-3001/, attribute: "note", value: /grain/i }],
  },
  {
    text: "Bluefin Marine pays on 60 day terms now, they changed it last month.",
    expect: [
      { subject: /Bluefin Marine/, attribute: "paymentTermDays", value: 60 },
    ],
  },
  {
    text: "Morning all, the coffee machine is broken again. Someone call facilities.",
    expect: [],
  },
  {
    text: "I wonder if maybe the deburr on P-1002 could be a bit slower than the sheet says, not sure though.",
    expect: [],
  },
];

let started = new Date();
const snapshot: {
  routings: {
    id: string;
    setupMin: number;
    runMinPerUnit: number;
    workCenterId: string;
    provenance: "data" | "stated" | "assumed";
    confidence: number;
  }[];
  workCenters: {
    id: string;
    efficiency: number;
    provenance: "data" | "stated" | "assumed";
  }[];
  materials: {
    id: string;
    leadTimeDays: number | null;
    provenance: "data" | "stated" | "assumed";
  }[];
  customers: { id: string; paymentTermDays: number | null }[];
} = { routings: [], workCenters: [], materials: [], customers: [] };

beforeAll(async () => {
  started = new Date();
  const db = forOrg(database, ORG_ID);
  const [finished, facts] = await Promise.all([
    db.job.count({ where: { actualEnd: { not: null } } }),
    db.fact.count(),
  ]);
  if (finished !== 52 || facts !== 0) {
    throw new Error(
      `The eval shop doesn't match seed/acme-precision (${finished} finished operations, ${facts} facts; expected 52 and 0). Run the seed.`
    );
  }
  snapshot.routings = await db.routing.findMany({
    select: {
      id: true,
      setupMin: true,
      runMinPerUnit: true,
      workCenterId: true,
      provenance: true,
      confidence: true,
    },
  });
  snapshot.workCenters = await db.workCenter.findMany({
    select: { id: true, efficiency: true, provenance: true },
  });
  snapshot.materials = await db.material.findMany({
    select: { id: true, leadTimeDays: true, provenance: true },
  });
  snapshot.customers = await db.customer.findMany({
    select: { id: true, paymentTermDays: true },
  });
}, 60_000);

afterAll(async () => {
  const db = forOrg(database, ORG_ID);
  await db.fact.deleteMany({});
  await db.note.deleteMany({ where: { createdAt: { gte: started } } });
  await db.order.deleteMany({ where: { createdAt: { gte: started } } });
  await db.scheduleRun.deleteMany({
    where: { objective: RECALIBRATION, createdAt: { gte: started } },
  });
  for (const { id, ...data } of snapshot.routings) {
    await database.routing.update({ where: { id }, data });
  }
  for (const { id, ...data } of snapshot.workCenters) {
    await database.workCenter.update({ where: { id }, data });
  }
  for (const { id, ...data } of snapshot.materials) {
    await database.material.update({ where: { id }, data });
  }
  for (const { id, ...data } of snapshot.customers) {
    await database.customer.update({ where: { id }, data });
  }
}, 120_000);

const factsFor = (noteId: string) =>
  forOrg(database, ORG_ID).fact.findMany({ where: { noteId } });

describe("notes become facts", () => {
  test.concurrent.for(
    NOTES.map((n) => [n.text.slice(0, 50), n] as const)
  )("%s", async ([, note], { expect }) => {
    const result = await saveNote(ORG_ID, USER, {
      kind: "voice",
      text: note.text,
    });
    const facts = await factsFor(result.noteId);
    for (const want of note.expect) {
      const found = facts.find(
        (f) =>
          f.attribute === want.attribute && want.subject.test(f.subjectLabel)
      );
      expect(
        found,
        `${want.attribute} on ${want.subject} in ${JSON.stringify(facts.map((f) => [f.subjectLabel, f.attribute, f.value]))}`
      ).toBeTruthy();
      if (typeof want.value === "number") {
        expect(
          Math.abs((found?.value as number) - want.value) / want.value
        ).toBeLessThan(0.02);
      } else {
        expect(String(found?.value)).toMatch(want.value);
      }
      expect(found?.status).toBe("pending");
      expect(found?.evidence).toBeTruthy();
    }
    // Nothing invented: every number fact is one we expected (notes may add context).
    const numbers = facts.filter((f) => f.attribute !== "note");
    expect(numbers.length).toBe(
      note.expect.filter((e) => typeof e.value === "number").length
    );
    if (note.expect.length === 0) {
      expect(facts).toEqual([]);
    }
  });
});

// Tests in a suite run one after another by default.
describe("review, recalibration and the error trend", () => {
  test("a correction told to Ask Takumo waits for review", async () => {
    const settings = await agentSettings({
      orgId: ORG_ID,
      userId: USER,
      today: EVAL_TODAY,
    });
    const result = await generateText({
      ...settings,
      prompt:
        "FYI the setup for P-1001 on the HAAS-VF2 is really 55 minutes, not 45. We timed the last three.",
    });
    const calls = result.steps.flatMap((s) =>
      s.toolCalls.map((c) => c.toolName)
    );
    expect(calls).toContain("propose_fact");
    const fact = await forOrg(database, ORG_ID).fact.findFirst({
      where: {
        source: "chat",
        attribute: "setupMin",
        subjectLabel: { contains: "P-1001 rev B op 10" },
      },
    });
    expect(fact?.value).toBe(55);
    expect(fact?.previousValue).toBe(45);
    expect(fact?.status).toBe("pending");
    expect(result.text).toMatch(/review|approv/i);
    // Cited, and nothing changed yet.
    const { cited } = linkCitations(
      result.text,
      collectSources(
        result.steps.flatMap((s) => s.toolResults.map((r) => r.output))
      )
    );
    expect(cited.map((c) => c.id)).toContain(
      `fact ${factLabel(fact?.number ?? 0)}`
    );
    const routing = await forOrg(database, ORG_ID).routing.findFirst({
      where: { seq: 10, part: { partNo: "P-1001" } },
    });
    expect(routing?.setupMin).toBe(45);
  });

  test("approving changes the routing; a newer approval supersedes it, keeping history", async () => {
    const db = forOrg(database, ORG_ID);
    const first = await db.fact.findFirst({
      where: { source: "chat", attribute: "setupMin" },
    });
    expect((await approveFact(ORG_ID, first?.id ?? "", USER)).ok).toBe(true);
    const routing = await db.routing.findFirst({
      where: { seq: 10, part: { partNo: "P-1001" } },
    });
    expect(routing).toMatchObject({ setupMin: 55, provenance: "stated" });

    const subject = await findSubject(ORG_ID, "routing", {
      partNo: "P-1001",
      seq: 10,
    });
    expect(subject.ok).toBe(true);
    const second = await proposeFact(ORG_ID, {
      subject: (
        subject as { subject: Parameters<typeof proposeFact>[1]["subject"] }
      ).subject,
      attribute: "setupMin",
      value: 50,
      evidence: "Re-timed after new fixture",
      source: "manual",
      statedBy: USER,
    });
    expect(second.ok).toBe(true);
    const secondId = (second as { fact: { id: string } }).fact.id;
    expect((await approveFact(ORG_ID, secondId, USER)).ok).toBe(true);
    const [old, current] = await Promise.all([
      db.fact.findFirst({ where: { id: first?.id } }),
      db.fact.findFirst({ where: { id: secondId } }),
    ]);
    expect(old?.status).toBe("superseded");
    expect(old?.validTo).not.toBeNull();
    expect(current).toMatchObject({
      status: "approved",
      supersedesFactId: first?.id,
      previousValue: 55,
    });
    expect(
      (
        await db.routing.findFirst({
          where: { seq: 10, part: { partNo: "P-1001" } },
        })
      )?.setupMin
    ).toBe(50);
    // Put it back for the rest of the eval.
    await database.routing.update({
      where: { id: routing?.id },
      data: { setupMin: 45 },
    });
  });

  test("recalibration finds what the job history says, once", async () => {
    const result = await recalibrate(ORG_ID, NOW, USER);
    const proposals = await forOrg(database, ORG_ID).fact.findMany({
      where: { source: RECALIBRATION },
      orderBy: { number: "asc" },
    });
    const summary = proposals.map((f) => [
      f.subjectLabel,
      f.attribute,
      f.value,
    ]);
    // The P-2001 lathe setup (~120 vs 90) and the P-3001 brake run (~1.35 vs 1.2).
    expect(summary).toHaveLength(2);
    const setup = proposals.find((f) => f.attribute === "setupMin");
    expect(setup?.subjectLabel).toMatch(/P-2001 rev C op 10/);
    expect(setup?.value as number).toBeGreaterThan(115);
    expect(setup?.value as number).toBeLessThan(128);
    expect(setup?.evidence).toMatch(/^Median of 4 jobs/);
    const run = proposals.find((f) => f.attribute === "runMinPerUnit");
    expect(run?.subjectLabel).toMatch(/P-3001 rev A op 10/);
    expect(Math.abs((run?.value as number) - 1.35)).toBeLessThan(0.05);
    expect(result.proposed).toHaveLength(2);

    // The voice note already proposed 120 for the same setup; both wait for review.
    // Running again doesn't duplicate anything.
    const again = await recalibrate(ORG_ID, NOW, USER);
    expect(again.proposed).toEqual([]);
    expect(again.refreshed).toEqual([]);
  });

  test("after the fix is approved, the next week's setup error drops", async () => {
    const db = forOrg(database, ORG_ID);
    const fix = await db.fact.findFirst({
      where: { source: RECALIBRATION, attribute: "setupMin" },
    });
    expect((await approveFact(ORG_ID, fix?.id ?? "", USER)).ok).toBe(true);

    const history = await loadFinishedJobs(
      ORG_ID,
      new Date(NOW.getTime() - 120 * DAY_MS)
    );
    const before = setupTrend(weeklyError(history)).latest;
    expect(before?.setupError).toBeGreaterThan(0.05);

    // A week of work on the floor with the corrected model: the same mix as the history.
    const parts = await db.part.findMany({
      select: { id: true, partNo: true },
    });
    const partId = (no: string) => parts.find((p) => p.partNo === no)?.id ?? "";
    const week = [
      { part: "P-2001", setup: [121, 41], run: [12.1 * 40, 4 * 40], qty: 40 },
      {
        part: "P-1001",
        setup: [46, 10],
        run: [6.1 * 150, 1.5 * 150],
        qty: 150,
      },
      { part: "P-3002", setup: [36, 5], run: [1.5 * 200, 1 * 200], qty: 200 },
      {
        part: "P-2002",
        setup: [77, 50, 10],
        run: [10 * 60, 7 * 60, 2.5 * 60],
        qty: 60,
      },
    ];
    for (const [i, w] of week.entries()) {
      const order = await db.order.create({
        data: {
          orgId: ORG_ID,
          orderNo: `EVAL-K-${i + 1}`,
          partId: partId(w.part),
          qty: w.qty,
          dueDate: new Date(NOW.getTime() + 14 * DAY_MS),
        },
      });
      const ops = await db.routing.findMany({
        where: { partId: order.partId },
        orderBy: { seq: "asc" },
      });
      for (const [j, op] of ops.entries()) {
        const logged = await logOperation(
          ORG_ID,
          USER,
          {
            orderId: order.id,
            seq: op.seq,
            setupMin: w.setup[j],
            runMin: w.run[j],
            qtyGood: w.qty,
            qtyScrap: 0,
            finishedAt: new Date(NOW.getTime() + ((i + j) * DAY_MS) / 2),
          },
          new Date(NOW.getTime() + 7 * DAY_MS)
        );
        expect(logged.ok).toBe(true);
      }
      expect(
        (await db.order.findFirst({ where: { id: order.id } }))?.status
      ).toBe("done");
    }

    const after = await loadFinishedJobs(
      ORG_ID,
      new Date(NOW.getTime() - 120 * DAY_MS)
    );
    const trend = setupTrend(weeklyError(after));
    expect(trend.latest?.week).toBe("2026-11-02");
    expect(trend.dropping).toBe(true);
    expect(trend.latest?.setupError).toBeLessThan(
      (before?.setupError ?? 0) / 2
    );
  });

  test("Ask Takumo uses approved knowledge, and cites it", async () => {
    const db = forOrg(database, ORG_ID);
    const grain = await db.fact.findFirst({
      where: { attribute: "note", value: { string_contains: "grain" } },
    });
    expect(grain).toBeTruthy();
    expect((await approveFact(ORG_ID, grain?.id ?? "", USER)).ok).toBe(true);
    const settings = await agentSettings({
      orgId: ORG_ID,
      userId: USER,
      today: EVAL_TODAY,
    });
    const result = await generateText({
      ...settings,
      prompt: "Anything I should know before running P-3001?",
    });
    expect(result.text).toMatch(/grain/i);
    const { cited } = linkCitations(
      result.text,
      collectSources(
        result.steps.flatMap((s) => s.toolResults.map((r) => r.output))
      )
    );
    expect(cited.map((c) => c.id)).toContain(
      `fact ${factLabel(grain?.number ?? 0)}`
    );
  });
});
