import { describe, expect, it } from "vitest";
import {
  acceptedQuotes,
  type CustomerRow,
  checkPo,
  findQuote,
  nearestBreak,
  type QuoteRow,
} from "../lib/orders/check";
import { enteredPos, poKey } from "../lib/orders/entered";
import { csvCell, poCsv, poSummary } from "../lib/orders/erp";
import { isoDay, normalizePo } from "../lib/orders/normalize";
import type { PoLine } from "../lib/orders/types";
import { chooseLane } from "../lib/quotes/screen";

const EXPIRED = /days old/;
const NEAREST = /Nearest: 200/;
const QUOTED_PRICE = /you quoted \$19\.75/;

describe("reading a PO", () => {
  it("cleans the header and lines", () => {
    const { header, lines } = normalizePo({
      poNo: " 4500123 ",
      customerName: "Cobalt Medical",
      orderDate: "2026-11-02T00:00:00Z",
      lines: [
        { partNo: "CM-1042", rev: "C", qty: 200, unitPrice: 19.75 },
        { partNo: "CM-2000", qty: 10, extended: 125 },
        { partNo: null, description: null, qty: 5 },
        { description: "Setup charge", qty: null },
      ],
    });
    expect(header.poNo).toBe("4500123");
    expect(header.orderDate).toBe("2026-11-02");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ lineNo: 1, extended: 3950 });
    expect(lines[1]).toMatchObject({ lineNo: 2, unitPrice: 12.5 });
  });

  it("only keeps real calendar days", () => {
    expect(isoDay("2026-02-30")).toBeNull();
    expect(isoDay("12/15/2026")).toBeNull();
    expect(isoDay("2026-12-15")).toBe("2026-12-15");
  });
});

const customers: CustomerRow[] = [
  {
    id: "c1",
    name: "Cobalt Medical, Inc.",
    emails: [],
    domains: ["cobalt-medical.com"],
  },
];
const quote = (over: Partial<QuoteRow> = {}): QuoteRow => ({
  id: "q1",
  quoteNo: "Q-1042",
  customerId: "c1",
  part: { partNo: "CM-1042", rev: "C" },
  qty: 50,
  price: null,
  leadTimeDays: 15,
  quotedAt: new Date("2026-11-01T00:00:00Z"),
  status: "open",
  rfqId: "r1",
  breaks: [
    { qty: 50, unitPrice: 24.9, leadTimeDays: 15 },
    { qty: 200, unitPrice: 19.75, leadTimeDays: 18 },
  ],
  ...over,
});
const line = (over: Partial<PoLine> = {}): PoLine => ({
  lineNo: 1,
  partNo: "CM-1042",
  rev: "C",
  description: null,
  qty: 200,
  unitPrice: 19.75,
  extended: 3950,
  dueDate: "2026-12-15",
  partId: null,
  quote: null,
  checks: [],
  ...over,
});
const check = (
  lines: PoLine[],
  over: Partial<Parameters<typeof checkPo>[0]> = {}
) =>
  checkPo({
    customers,
    header: {
      poNo: "4500123",
      customerName: "Cobalt Medical",
      contact: null,
      orderDate: null,
      shipTo: null,
      terms: null,
      notes: null,
    },
    lines,
    parts: [{ id: "p1", partNo: "CM-1042", rev: "C" }],
    quotes: [quote()],
    sender: "buyer@cobalt-medical.com",
    today: "2026-11-05",
    validityDays: 30,
    ...over,
  });
const kinds = (l: PoLine) => l.checks.map((c) => c.kind);

describe("checking a PO against the quote", () => {
  it("passes a PO that matches the quote", () => {
    const r = check([line()]);
    expect(r.customerId).toBe("c1");
    expect(r.checks).toEqual([]);
    expect(r.lines[0].checks).toEqual([]);
    expect(r.lines[0].quote).toMatchObject({
      quoteNo: "Q-1042",
      unitPrice: 19.75,
    });
    expect(r.lines[0].partId).toBe("p1");
  });

  it("flags a different price", () => {
    const r = check([line({ unitPrice: 18 })]);
    expect(kinds(r.lines[0])).toEqual(["price_differs"]);
    expect(r.lines[0].checks[0].message).toMatch(QUOTED_PRICE);
    // Within half a percent is the same price.
    expect(kinds(check([line({ unitPrice: 19.8 })]).lines[0])).toEqual([]);
  });

  it("flags a quantity that wasn't quoted, using the nearest break", () => {
    const r = check([line({ qty: 150, unitPrice: 19.75 })]);
    expect(kinds(r.lines[0])).toContain("qty_not_quoted");
    expect(r.lines[0].checks[0].message).toMatch(NEAREST);
    expect(nearestBreak([{ qty: 50 }, { qty: 150 }], 100)?.qty).toBe(150);
  });

  it("flags a revision change and won't accept the quote for it", () => {
    const r = check([line({ rev: "D" })]);
    expect(kinds(r.lines[0])).toContain("rev_differs");
    expect(acceptedQuotes(r.lines)).toEqual([]);
  });

  it("flags a due date sooner than the quoted lead time", () => {
    const r = check([line({ dueDate: "2026-11-10" })]);
    expect(kinds(r.lines[0])).toEqual(["due_before_lead_time"]);
  });

  it("flags an expired quote", () => {
    const r = check([line()], { today: "2026-12-20" });
    expect(kinds(r.lines[0])).toContain("quote_expired");
    expect(
      r.lines[0].checks.find((c) => c.kind === "quote_expired")?.message
    ).toMatch(EXPIRED);
  });

  it("flags no quote, unknown parts, unknown customers and missing fields", () => {
    const none = check([line()], { quotes: [] });
    expect(kinds(none.lines[0])).toEqual(["no_quote"]);
    const unknown = check([line({ partNo: "ZZ-9" })], { quotes: [] });
    expect(kinds(unknown.lines[0])).toContain("unknown_part");
    const stranger = check([line()], {
      sender: "x@other.com",
      header: {
        ...check([]).lines,
        poNo: null,
        customerName: "Someone Else",
      } as never,
    });
    expect(stranger.checks.map((c) => c.kind)).toEqual([
      "customer_unknown",
      "missing_field",
    ]);
    const blank = check([line({ partNo: null, qty: null, dueDate: null })]);
    expect(kinds(blank.lines[0])).toEqual([
      "missing_field",
      "missing_field",
      "missing_field",
    ]);
  });

  it("matches the customer by name when the sender is unknown", () => {
    expect(check([line()], { sender: "jo@gmail.com" }).customerId).toBe("c1");
  });

  it("prefers the quote for the same revision", () => {
    const older = quote({
      id: "q0",
      quoteNo: "Q-0900",
      part: { partNo: "CM-1042", rev: "B" },
      quotedAt: new Date("2026-11-03T00:00:00Z"),
    });
    expect(findQuote(line(), "c1", [older, quote()])?.quoteNo).toBe("Q-1042");
    // Lost quotes don't count.
    expect(findQuote(line(), "c1", [quote({ status: "lost" })])).toBeNull();
  });

  it("accepts each quote at most once", () => {
    const r = check([line(), line({ lineNo: 2 })]);
    expect(acceptedQuotes(r.lines)).toEqual([]);
    expect(acceptedQuotes(check([line()]).lines)).toHaveLength(1);
  });
});

describe("ready for the ERP", () => {
  const po = {
    customer: "Cobalt, Medical",
    poNo: "4500123",
    shipTo: null,
    terms: "Net 30",
    lines: [line({ description: 'Bracket, 4" "wide"' })],
  };

  it("escapes CSV cells and blocks formulas", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(null)).toBe("");
    const csv = poCsv(po).split("\r\n");
    expect(csv[0]).toBe(
      "Customer,Customer PO,Line,Part,Rev,Description,Qty,Unit price,Due date"
    );
    expect(csv[1]).toBe(
      '"Cobalt, Medical",4500123,1,CM-1042,C,"Bracket, 4"" ""wide""",200,19.75,2026-12-15'
    );
  });

  it("writes a plain summary", () => {
    const text = poSummary(po);
    expect(text).toContain("Customer PO: 4500123");
    expect(text).toContain(
      "1. CM-1042 rev C, qty 200, $19.75 each, due 2026-12-15"
    );
    expect(text).toContain("Total: $3,950.00");
  });
});

describe("marking POs entered from the ERP", () => {
  const waiting = {
    id: "po1",
    poNo: "PO# 4500-123",
    customerId: "c1",
    receivedAt: new Date("2026-11-05T00:00:00Z"),
    lines: [{ partId: "p1", partNo: "CM-1042", qty: 200 }],
  };
  const order = {
    customerPo: null as string | null,
    customerId: "c1",
    partId: "p1",
    partNo: "CM-1042",
    qty: 200,
    createdAt: new Date("2026-11-06T00:00:00Z"),
  };

  it("matches the customer PO number however it's written", () => {
    expect(poKey("PO# 4500-123")).toBe(poKey("4500123"));
    expect(
      enteredPos([waiting], [{ ...order, qty: 1, customerPo: "4500123" }])
    ).toEqual(["po1"]);
  });

  it("matches the same customer, part and quantity after the PO came in", () => {
    expect(enteredPos([waiting], [order])).toEqual(["po1"]);
    const before = { ...order, createdAt: new Date("2026-11-01T00:00:00Z") };
    expect(enteredPos([waiting], [before])).toEqual([]);
    expect(enteredPos([waiting], [{ ...order, qty: 199 }])).toEqual([]);
    expect(enteredPos([waiting], [{ ...order, customerId: "c2" }])).toEqual([]);
  });
});

describe("screening a purchase order", () => {
  const po = {
    isRfq: false,
    kind: "po" as const,
    confidence: "high",
    summary: "PO 4500123",
  };
  const base = {
    blocked: false,
    customerId: "c1",
    freeProblem: null,
    known: true,
    triage: po,
  };

  it("sends a customer's PO to Incoming POs", () => {
    expect(chooseLane(base).lane).toBe("po");
  });

  it("filters a PO from someone Takumo doesn't know", () => {
    const lane = chooseLane({ ...base, known: false, customerId: null });
    expect(lane.lane).toBe("filtered");
    expect(lane.reason).toContain("purchase order");
  });

  it("treats a low-confidence PO like any other email", () => {
    expect(
      chooseLane({ ...base, triage: { ...po, confidence: "low" } }).lane
    ).toBe("full");
  });
});
