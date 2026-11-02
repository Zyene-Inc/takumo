import { readFileSync } from "node:fs";
import path from "node:path";
import { database, forOrg } from "@repo/database";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { approveRfq, recordOutcome } from "@/lib/quotes/approve";
import { quoteDocument } from "@/lib/quotes/document";
import { estimateLine, loadQuoteHistory } from "@/lib/quotes/estimate";
import { intakeRfq } from "@/lib/quotes/intake";
import { acceptance } from "@/lib/quotes/numbers";
import { renderQuotePdf } from "@/lib/quotes/pdf";
import { readRfqFile } from "@/lib/quotes/read";
import type { LineDraft } from "@/lib/quotes/types";
import { loadRfqView } from "@/lib/quotes/view";
import { EVAL_TODAY } from "./golden";

// Quote Copilot end to end on the demo shop: the model reads real-looking
// RFQs (email, HTML email with nothing but HTML, email with the RFQ as a PDF
// attachment, PDF, Word, pasted text), the engine prices them, an estimator
// approves, the customer says yes. Needs the database, the engine
// (pnpm dev:engine) and ANTHROPIC_API_KEY. Leaves the shop as it was.
const ORG_ID = process.env.EVAL_ORG_ID ?? "org_01M64Y2YX6Q7517K5KJR1185CA";
const EVAL_USER = "eval:quote-copilot";
const DIR = path.resolve(import.meta.dirname, "rfqs");

interface ExpectedLine {
  finish?: RegExp;
  inShop: boolean;
  material?: string;
  partNo: string;
  qtys: number[];
  rev: string;
  tolerances?: RegExp;
}

interface RfqGolden {
  contact?: RegExp;
  customer?: string;
  /** The customer is in the shop. */
  customerKnown?: boolean;
  file: string;
  lines?: ExpectedLine[];
  notes?: RegExp;
  requestedDate?: string;
  status: "review" | "failed";
}

const AL = "AL6061-T6 bar 2in";
const SS = "SS316 bar 1.5in";
const CRS = "CRS sheet 14ga";

const GOLDEN: RfqGolden[] = [
  {
    file: "northwind-brackets.eml",
    status: "review",
    customer: "Northwind Robotics",
    customerKnown: true,
    contact: /Dana Ruiz/,
    requestedDate: "2026-12-04",
    lines: [
      {
        partNo: "P-1001",
        rev: "B",
        qtys: [50, 150, 400],
        material: AL,
        inShop: true,
      },
    ],
  },
  {
    file: "bluefin-shaft.txt",
    status: "review",
    customer: "Bluefin Marine",
    customerKnown: true,
    contact: /Marco Bell/,
    requestedDate: "2026-12-18",
    lines: [
      {
        partNo: "P-2001",
        rev: "C",
        qtys: [40, 80],
        material: SS,
        finish: /passivat/i,
        inShop: true,
      },
    ],
  },
  {
    file: "bluefin-hub.eml",
    status: "review",
    customer: "Bluefin Marine",
    customerKnown: true,
    requestedDate: "2026-12-22",
    lines: [
      { partNo: "P-2002", rev: "A", qtys: [60], material: SS, inShop: true },
    ],
  },
  {
    file: "cobalt-trays.pdf",
    status: "review",
    customer: "Cobalt Medical",
    customerKnown: true,
    contact: /Priya Shah/,
    requestedDate: "2027-01-15",
    notes: /cert/i,
    lines: [
      { partNo: "P-3001", rev: "A", qtys: [1000], material: CRS, inShop: true },
      {
        partNo: "CM-4410",
        rev: "A",
        qtys: [250, 500],
        material: CRS,
        finish: /powder/i,
        inShop: false,
      },
    ],
  },
  {
    file: "harbor-sensor-bracket.docx",
    status: "review",
    customer: "Harbor Automation",
    customerKnown: false,
    contact: /Lee Okafor/,
    requestedDate: "2027-01-08",
    lines: [
      {
        partNo: "HA-220",
        rev: "A",
        qtys: [25, 100],
        material: AL,
        finish: /anodi/i,
        tolerances: /0\.002/,
        inShop: false,
      },
    ],
  },
  {
    // A revision the shop hasn't made yet is a new part.
    file: "northwind-rev-c.txt",
    status: "review",
    customer: "Northwind Robotics",
    customerKnown: true,
    requestedDate: "2026-12-11",
    lines: [
      {
        partNo: "P-1001",
        rev: "C",
        qtys: [200],
        material: AL,
        finish: /anodi/i,
        inShop: false,
      },
    ],
  },
  { file: "not-rfq.txt", status: "failed" },
];

const rfqIds = new Map<string, string>();
let started = new Date();

beforeAll(async () => {
  started = new Date();
  const db = forOrg(database, ORG_ID);
  const [quotes, parts] = await Promise.all([
    db.quote.count(),
    db.part.count(),
  ]);
  if (!(quotes === 8 && parts === 6)) {
    throw new Error(
      `The eval shop doesn't match seed/acme-precision (${quotes} quotes, ${parts} parts; expected 8 and 6).`
    );
  }
}, 60_000);

afterAll(async () => {
  // Leave the demo shop as it was.
  const db = forOrg(database, ORG_ID);
  const rfqs = await db.rfq.findMany({
    where: { createdBy: EVAL_USER },
    select: { id: true },
  });
  const ids = rfqs.map((r) => r.id);
  await db.quote.deleteMany({ where: { rfqId: { in: ids } } });
  await db.order.deleteMany({ where: { createdAt: { gte: started } } });
  await db.rfq.deleteMany({ where: { id: { in: ids } } });
  await db.part.deleteMany({ where: { createdAt: { gte: started } } });
  await db.customer.deleteMany({ where: { createdAt: { gte: started } } });
});

const lineView = async (file: string) => {
  const id = rfqIds.get(file);
  if (!id) {
    throw new Error(`${file} wasn't read`);
  }
  const view = await loadRfqView(ORG_ID, id);
  if (!view) {
    throw new Error(`${file}: RFQ missing`);
  }
  return view;
};

describe("reading RFQs", () => {
  test.concurrent.for(GOLDEN.map((g) => [g.file, g] as const))("%s", async ([
    file,
    golden,
  ], { expect }) => {
    const text = await readRfqFile(
      file,
      new Uint8Array(readFileSync(path.join(DIR, file)))
    );
    const rfq = await intakeRfq(ORG_ID, EVAL_USER, text, {
      fileName: file,
      checkDuplicates: false,
    });
    rfqIds.set(file, rfq.id);
    const view = await loadRfqView(ORG_ID, rfq.id);
    expect(view?.status).toBe(golden.status);
    if (golden.status === "failed" || !view) {
      return;
    }
    expect(view.customerName).toContain(golden.customer);
    expect(view.customerKnown).toBe(golden.customerKnown);
    if (golden.contact) {
      expect(view.contact).toMatch(golden.contact);
    }
    expect(view.requestedDate).toBe(golden.requestedDate);
    if (golden.notes) {
      expect(
        `${view.notes} ${view.lines.map((l) => l.notes).join(" ")}`
      ).toMatch(golden.notes);
    }
    expect(view.lines).toHaveLength(golden.lines?.length ?? 0);
    for (const [i, want] of (golden.lines ?? []).entries()) {
      const line = view.lines[i];
      expect(line.partNo).toBe(want.partNo);
      expect(line.rev).toBe(want.rev);
      expect(line.qtys).toEqual(want.qtys);
      expect(Boolean(line.part)).toBe(want.inShop);
      if (want.material) {
        expect(line.material?.name).toBe(want.material);
      }
      if (want.finish) {
        expect(line.finish).toMatch(want.finish);
      }
      if (want.tolerances) {
        expect(line.tolerances).toMatch(want.tolerances);
      }
    }
  });

  test("a vague request becomes questions for the customer, not a guess", async () => {
    const text = await readRfqFile(
      "vague.txt",
      new Uint8Array(readFileSync(path.join(DIR, "vague.txt")))
    );
    const rfq = await intakeRfq(ORG_ID, EVAL_USER, text, {
      fileName: "vague.txt",
      checkDuplicates: false,
    });
    const view = await loadRfqView(ORG_ID, rfq.id);
    expect(view?.lines.every((l) => !l.part)).toBe(true);
    expect(view?.questions.join(" ")).toMatch(/part|drawing|which/i);
  });
});

// Tests in a suite run one after another by default.
describe("drafting, approving and winning a quote", () => {
  test("a part the shop makes: priced from its routing and history", async () => {
    const view = await lineView("northwind-brackets.eml");
    const result = await estimateLine(ORG_ID, view.lines[0].id, EVAL_TODAY);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    const draft = (result as { draft: LineDraft }).draft;
    const r = draft.response;
    expect(r.missing).toEqual([]);
    expect(r.breaks.map((b) => b.qty)).toEqual([50, 150, 400]);
    for (const b of r.breaks) {
      expect(b.unit_price).toBeGreaterThan(0);
      expect(b.lead_time_days).not.toBeNull();
    }
    // Bigger lots are cheaper per part.
    const units = r.breaks.map((b) => b.unit_price ?? 0);
    expect(units).toEqual([...units].sort((a, b) => b - a));
    // Evidence: the part's own past quotes, and Northwind's margins.
    expect(
      r.comparables
        .slice(0, 2)
        .map((c) => c.quote_no)
        .sort()
    ).toEqual(["Q-9001", "Q-9002"]);
    expect([...r.margin.sources].sort()).toEqual([
      "quote Q-9001",
      "quote Q-9002",
    ]);
    expect(
      [
        ...(r.breaks[0].lines.find((l) => l.kind === "material")?.sources ??
          []),
      ].sort()
    ).toEqual(["quote Q-9001", "quote Q-9002"]);
    expect(r.breaks[0].meets_requested).toBe(true);
    // The job history has 4 finished jobs per operation: their median times are used.
    for (const op of draft.inputs.routing) {
      expect(op.source).toBe("actuals");
      expect(op.note).toMatch(/^median of 4 jobs/);
    }
  });

  test("a new part: operations estimated from similar parts, every time traceable", async () => {
    const view = await lineView("harbor-sensor-bracket.docx");
    const result = await estimateLine(ORG_ID, view.lines[0].id, EVAL_TODAY);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    const r = (result as { draft: LineDraft }).draft;
    expect(r.inputs.newPart).toBe(true);
    expect(r.inputs.routing.length).toBeGreaterThan(0);
    for (const op of r.inputs.routing) {
      expect(op.source).toBe("comparable");
      expect(op.note).toBeTruthy();
    }
    // At least one operation is based on a shop part's operation.
    expect(
      r.inputs.routing.some((op) => /P-\d{4} op \d+/.test(op.note ?? ""))
    ).toBe(true);
    expect(r.response.breaks.every((b) => (b.unit_price ?? 0) > 0)).toBe(true);
    // Material comes from other aluminum parts, and says so; the anodize isn't priced yet.
    expect(r.response.warnings.join(" ")).toMatch(/No cost history for HA-220/);
    expect(r.response.warnings.join(" ")).toMatch(/Not priced yet: .*anodi/i);
    expect(
      r.response.comparables.some(
        (c) => c.part_no === "P-1001" || c.part_no === "P-1002"
      )
    ).toBe(true);
  });

  test("approve → quote with the draft beside it → PDF → won → order", async () => {
    const id = rfqIds.get("northwind-brackets.eml") as string;
    await database.rfq.update({ where: { id }, data: { status: "drafted" } });
    const approved = await approveRfq(ORG_ID, EVAL_USER, id);
    expect(approved.ok, approved.ok ? "" : approved.error).toBe(true);
    const quoteNos = (approved as { quoteNos: string[] }).quoteNos;
    expect(quoteNos).toEqual(["Q-9009"]);

    const quote = await forOrg(database, ORG_ID).quote.findFirst({
      where: { quoteNo: "Q-9009" },
    });
    expect(quote?.qty).toBe(50);
    expect(Number(quote?.price)).toBe(Number(quote?.draftPrice));
    expect(quote?.leadTimeDays).toBe(quote?.draftLeadTimeDays);
    expect((quote?.breaks as unknown[]).length).toBe(3);

    const view = await lineView("northwind-brackets.eml");
    expect(view.status).toBe("quoted");
    const bytes = await renderQuotePdf(quoteDocument(view, "Acme Precision"));
    const { extractText, getDocumentProxy } = await import("unpdf");
    const { text } = await extractText(await getDocumentProxy(bytes), {
      mergePages: true,
    });
    expect(text).toContain("Q-9009");
    expect(text).toContain("Northwind Robotics");
    expect(text).toContain("P-1001 rev B");

    const won = await recordOutcome(
      ORG_ID,
      id,
      { lineId: view.lines[0].id, status: "won", qty: 150 },
      EVAL_TODAY
    );
    expect(won.ok, won.ok ? "" : won.error).toBe(true);
    expect((won as { orderNo: string }).orderNo).toBe("SO-5007");
    const order = await forOrg(database, ORG_ID).order.findFirst({
      where: { orderNo: "SO-5007" },
    });
    const breaks = quote?.breaks as {
      qty: number;
      leadTimeDays: number;
      price: number;
    }[];
    const chosen = breaks.find((b) => b.qty === 150);
    expect(order?.qty).toBe(150);
    expect(Number(order?.price)).toBe(chosen?.price);
    expect(order?.dueDate.toISOString().slice(0, 10)).toBe(
      new Date(
        Date.parse(`${EVAL_TODAY}T00:00:00Z`) +
          (chosen?.leadTimeDays ?? 0) * 86_400_000
      )
        .toISOString()
        .slice(0, 10)
    );
    expect((await lineView("northwind-brackets.eml")).status).toBe("won");

    // Sent as drafted, so it counts as accepted.
    const drafted = await forOrg(database, ORG_ID).quote.findMany({
      where: { draftPrice: { not: null } },
      select: {
        price: true,
        draftPrice: true,
        leadTimeDays: true,
        draftLeadTimeDays: true,
      },
    });
    expect(
      acceptance(
        drafted.map((q) => ({
          price: Number(q.price),
          draftPrice: Number(q.draftPrice),
          leadTimeDays: q.leadTimeDays,
          draftLeadTimeDays: q.draftLeadTimeDays,
        }))
      )
    ).toEqual({ drafted: 1, accepted: 1, rate: 1 });
  });

  test("history now includes the new quote", async () => {
    const history = await loadQuoteHistory(ORG_ID);
    expect(history.history.find((q) => q.quote_no === "Q-9009")?.status).toBe(
      "won"
    );
  });
});
