import { readFileSync } from "node:fs";
import path from "node:path";
import type { QuoteResponse } from "@repo/engine-client/types";
import { describe, expect, test } from "vitest";
import { approvalProblems, finalFor } from "../lib/quotes/approval";
import { decodeWords, htmlToText, parseEmail } from "../lib/quotes/email";
import {
  matchCustomer,
  matchMaterial,
  matchPart,
  normalizePartNo,
  partsMentioned,
} from "../lib/quotes/match";
import {
  acceptance,
  acceptedWithSmallEdits,
  nextNumber,
  parseQtys,
  startingFinal,
} from "../lib/quotes/numbers";
import { renderQuotePdf } from "../lib/quotes/pdf";
import { readPasted, readRfqFile } from "../lib/quotes/read";
import { replyEmail } from "../lib/quotes/reply";
import {
  applyProposal,
  type CandidatePart,
  similarParts,
  withActuals,
} from "../lib/quotes/routing";

const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dirname, "fixtures", name));

const CRLF = "\r\n";

/** A multipart RFQ email: quoted-printable text, an HTML twin, and a PDF attached. */
const rfqEmail = () =>
  [
    "From: Dana Ruiz <dana@northwind.example>",
    "To: quotes@acme.example",
    "Subject: =?UTF-8?B?UkZRIOKAkyBncmlwcGVyIGJyYWNrZXRz?=",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "--outer",
    'Content-Type: multipart/alternative; boundary="inner"',
    "",
    "--inner",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Please quote 50 / 150 pcs of P-1001 rev B =E2=80=93 6061-T6.=",
    " Needed by Dec 4.",
    "",
    "--inner",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Please quote <b>50 / 150</b> pcs</p>",
    "--inner--",
    "",
    "--outer",
    'Content-Type: application/pdf; name="drawing.pdf"',
    'Content-Disposition: attachment; filename="drawing.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    fixture("sample.pdf")
      .toString("base64")
      .replace(/(.{76})/g, `$1${CRLF}`),
    "--outer--",
    "",
  ].join(CRLF);

describe("RFQ emails", () => {
  test("reads the subject, sender, plain body and attachments", () => {
    const email = parseEmail(rfqEmail());
    expect(email.subject).toBe("RFQ – gripper brackets");
    expect(email.from).toBe("Dana Ruiz <dana@northwind.example>");
    expect(email.body).toBe(
      "Please quote 50 / 150 pcs of P-1001 rev B – 6061-T6. Needed by Dec 4."
    );
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0].name).toBe("drawing.pdf");
    expect(
      Buffer.from(email.attachments[0].bytes).equals(fixture("sample.pdf"))
    ).toBe(true);
  });

  test("an .eml upload includes the text of its PDF attachment", async () => {
    const read = await readRfqFile(
      "rfq.eml",
      new TextEncoder().encode(rfqEmail())
    );
    expect(read.source).toBe("email");
    expect(read.subject).toBe("RFQ – gripper brackets");
    expect(read.body).toContain("P-1001 rev B");
    expect(read.body).toContain("--- Attachment: drawing.pdf ---");
    expect(read.body).toContain("Break all edges 0.2 to 0.4 mm on P-3001");
  });

  test("an HTML-only email becomes readable text", () => {
    const email = parseEmail(
      [
        "Subject: RFQ",
        "Content-Type: text/html",
        "",
        "<html><style>p{}</style><p>Qty&nbsp;60</p><br><div>P-2002 &amp; P-2001</div></html>",
      ].join("\n")
    );
    expect(email.body).toBe("Qty 60\n\nP-2002 & P-2001");
  });

  test("encoded words and HTML entities", () => {
    expect(decodeWords("=?iso-8859-1?Q?Fr=E4sen_Teil?=")).toBe("Fräsen Teil");
    expect(htmlToText("<p>a</p><p>b</p>")).toBe("a\nb");
  });

  test("pasted text keeps Subject and From when present", () => {
    expect(
      readPasted("From: buyer@x.com\nSubject: RFQ 12\n\nQuote 10 pcs")
    ).toMatchObject({
      source: "email",
      subject: "RFQ 12",
      sender: "buyer@x.com",
    });
    expect(readPasted("Quote 10 pcs of P-1").source).toBe("paste");
  });

  test("refuses file types it can't read", async () => {
    await expect(
      readRfqFile("drawing.step", new Uint8Array([1]))
    ).rejects.toThrow(/reads RFQs/);
  });
});

describe("matching an RFQ to the shop", () => {
  const customers = [
    { id: "c1", name: "Bluefin Marine" },
    { id: "c2", name: "Northwind Robotics" },
    { id: "c3", name: "Cobalt Medical" },
  ];
  const parts = [
    { id: "p1", partNo: "P-1001", rev: "B" },
    { id: "p0", partNo: "P-1001", rev: "A" },
    { id: "p2", partNo: "P-2001", rev: "C" },
  ];
  const materials = [
    { id: "m1", name: "AL6061-T6 bar 2in" },
    { id: "m2", name: "SS316 bar 1.5in" },
    { id: "m3", name: "CRS sheet 14ga" },
  ];

  test("customers by name, ignoring Inc. and punctuation", () => {
    expect(matchCustomer("Bluefin Marine, Inc.", customers)?.id).toBe("c1");
    expect(matchCustomer("northwind robotics llc", customers)?.id).toBe("c2");
    expect(matchCustomer("Northwind Robotics Europe", customers)?.id).toBe(
      "c2"
    );
    expect(matchCustomer("Harbor Automation", customers)).toBeNull();
    expect(matchCustomer("", customers)).toBeNull();
  });

  test("parts by number and revision", () => {
    expect(matchPart("p 1001", "b", parts)).toEqual({
      part: parts[0],
      otherRev: null,
    });
    // No revision given: the latest one.
    expect(matchPart("P1001", null, parts).part?.rev).toBe("B");
    // A revision the shop hasn't made is a new part, based on the latest it has.
    expect(matchPart("P-1001", "C", parts)).toEqual({
      part: null,
      otherRev: parts[0],
    });
    expect(matchPart("HA-220", null, parts)).toEqual({
      part: null,
      otherRev: null,
    });
  });

  test("materials need the same alloy, then the closest wording", () => {
    expect(
      matchMaterial("6061-T6 aluminum, 2 in round bar", materials)?.id
    ).toBe("m1");
    expect(matchMaterial("316 stainless bar 1.5 in", materials)?.id).toBe("m2");
    expect(matchMaterial("304 stainless bar 1.5 in", materials)).toBeNull();
    expect(matchMaterial("14 ga CRS sheet", materials)?.id).toBe("m3");
    expect(matchMaterial("Delrin", materials)).toBeNull();
  });

  test("finds shop part numbers written in the RFQ", () => {
    expect(normalizePartNo("P-1001 Rev.B")).toBe("p1001revb");
    expect(
      partsMentioned("Need P1001 and p-2001 asap", parts).map((p) => p.id)
    ).toEqual(["p1", "p0", "p2"]);
  });
});

describe("operations for a quote", () => {
  const routing = [
    { seq: 10, work_center: "HAAS-VF2", setup_min: 45, run_min_per_unit: 6 },
    { seq: 20, work_center: "DEBURR-1", setup_min: 10, run_min_per_unit: 1.5 },
  ];

  test("actual times replace the routing once there are enough jobs", () => {
    const ops = withActuals(routing, [
      { routingSeq: 10, actualSetupMin: 50, actualRunMin: 700, qty: 100 },
      { routingSeq: 10, actualSetupMin: 60, actualRunMin: 1300, qty: 200 },
      { routingSeq: 20, actualSetupMin: 12, actualRunMin: 160, qty: 100 },
    ]);
    expect(ops[0]).toMatchObject({
      source: "actuals",
      setup_min: 55,
      run_min_per_unit: 6.75,
    });
    expect(ops[0].note).toContain("median of 2 jobs");
    // One job isn't enough.
    expect(ops[1]).toMatchObject({ source: "routing", setup_min: 10 });
  });

  const candidates: CandidatePart[] = [
    {
      id: "a",
      partNo: "P-1001",
      rev: "B",
      description: "Gripper bracket",
      material: "AL6061-T6 bar 2in",
      customer: "Northwind Robotics",
      routing,
    },
    {
      id: "b",
      partNo: "P-2001",
      rev: "C",
      description: "Pump shaft",
      material: "SS316 bar 1.5in",
      customer: "Bluefin Marine",
      routing: [
        {
          seq: 10,
          work_center: "OKUMA-LB3000",
          setup_min: 90,
          run_min_per_unit: 12,
        },
      ],
    },
  ];

  test("similar parts: same material and shared words first", () => {
    const found = similarParts(
      {
        partNo: "HA-220",
        description: "Sensor bracket",
        materialName: "AL6061-T6 bar 2in",
      },
      null,
      candidates
    );
    expect(found[0].partNo).toBe("P-1001");
  });

  test("a proposal's times are a comparable operation × a bounded factor", () => {
    const { ops, dropped } = applyProposal(
      [
        {
          workCenter: "HAAS-VF2",
          basisPartNo: "P-1001",
          basisSeq: 10,
          setupScale: 1.2,
          runScale: 10, // capped at 4
          setupMin: null,
          runMinPerUnit: null,
          reason: "deeper pocket",
        },
        {
          workCenter: "LASER-9",
          basisPartNo: null,
          basisSeq: null,
          setupScale: null,
          runScale: null,
          setupMin: 5,
          runMinPerUnit: 1,
          reason: "marking",
        },
        {
          workCenter: "DEBURR-1",
          basisPartNo: null,
          basisSeq: null,
          setupScale: null,
          runScale: null,
          setupMin: 8,
          runMinPerUnit: 2,
          reason: "break edges",
        },
      ],
      candidates,
      ["HAAS-VF2", "DEBURR-1"]
    );
    expect(ops[0]).toMatchObject({
      seq: 10,
      setup_min: 54,
      run_min_per_unit: 24,
      source: "comparable",
    });
    expect(ops[0].note).toContain("P-1001 op 10 (45 min + 6 min/ea)");
    expect(ops[1]).toMatchObject({
      seq: 20,
      setup_min: 8,
      run_min_per_unit: 2,
    });
    expect(ops[1].note).toContain("Takumo's estimate");
    expect(dropped).toEqual(["LASER-9 isn't one of the shop's machines"]);
  });
});

const response = (
  breaks: { qty: number; unit_price: number | null; lead: number | null }[]
): QuoteResponse => ({
  status: "OPTIMAL",
  breaks: breaks.map((b) => ({
    qty: b.qty,
    lines: [],
    cost: b.unit_price === null ? null : b.unit_price * b.qty * 0.75,
    unit_cost: null,
    unit_price: b.unit_price,
    price: b.unit_price === null ? null : b.unit_price * b.qty,
    price_low: null,
    price_high: null,
    margin_pct: null,
    completion_date: null,
    lead_time_days: b.lead,
    meets_requested: null,
  })),
  comparables: [],
  margin: { target: 0.25, low: 0.2, high: 0.3, basis: "", sources: [] },
  checks: [],
  missing: [],
  warnings: [],
  lead_time_note: null,
});

describe("numbers", () => {
  test("next number in the shop's own series", () => {
    expect(nextNumber(["Q-9001", "Q-9008", "Q-9003"], "Q-0001")).toBe("Q-9009");
    expect(nextNumber(["SO-0099", "SO-0100", "NEW-261102-1"], "SO-1")).toBe(
      "SO-0101"
    );
    expect(nextNumber(["Q-9009"], "Q-0001")).toBe("Q-9010");
    expect(nextNumber([], "Q-0001")).toBe("Q-0001");
    expect(nextNumber(["ACME"], "Q-0001")).toBe("Q-0001");
  });

  test("quantities as typed", () => {
    expect(parseQtys("50, 100, 250")).toEqual([50, 100, 250]);
    expect(parseQtys("50/100 / 100")).toEqual([50, 100]);
    expect(parseQtys("1000")).toEqual([1000]);
    expect(parseQtys("50, ten")).toBeNull();
    expect(parseQtys("0")).toBeNull();
    expect(parseQtys(" ")).toBeNull();
  });

  test("a draft is accepted within 5% on price and 2 days on lead time", () => {
    const base = { draftPrice: 1000, draftLeadTimeDays: 10 };
    expect(
      acceptedWithSmallEdits({ ...base, price: 1050, leadTimeDays: 12 })
    ).toBe(true);
    expect(
      acceptedWithSmallEdits({ ...base, price: 1051, leadTimeDays: 10 })
    ).toBe(false);
    expect(
      acceptedWithSmallEdits({ ...base, price: 1000, leadTimeDays: 13 })
    ).toBe(false);
    expect(
      acceptedWithSmallEdits({ ...base, price: 980, leadTimeDays: null })
    ).toBe(true);
    expect(
      acceptance([
        { ...base, price: 1000, leadTimeDays: 10 },
        { ...base, price: 1500, leadTimeDays: 10 },
        {
          draftPrice: null,
          draftLeadTimeDays: null,
          price: 10,
          leadTimeDays: 1,
        },
      ])
    ).toEqual({ drafted: 2, accepted: 1, rate: 0.5 });
    expect(acceptance([]).rate).toBeNull();
  });

  test("the estimator starts from the draft's prices", () => {
    expect(
      startingFinal(
        response([
          { qty: 50, unit_price: 44, lead: 3 },
          { qty: 400, unit_price: 42, lead: 9 },
        ])
      )
    ).toEqual({
      breaks: [
        { qty: 50, unitPrice: 44, leadTimeDays: 3 },
        { qty: 400, unitPrice: 42, leadTimeDays: 9 },
      ],
    });
    expect(
      startingFinal(response([{ qty: 50, unit_price: null, lead: 3 }]))
    ).toBeNull();
  });
});

describe("approval", () => {
  const draft = { response: response([{ qty: 50, unit_price: 44, lead: 3 }]) };
  const line = { lineNo: 1, partNo: "P-1001", qtys: [50], draft, final: null };

  test("a complete RFQ has no problems; the draft's prices are sent", () => {
    expect(
      approvalProblems({
        customerName: "Northwind",
        customerId: null,
        lines: [line],
      })
    ).toEqual([]);
    expect(finalFor(line)?.breaks[0].unitPrice).toBe(44);
  });

  test("names everything that's missing", () => {
    expect(
      approvalProblems({
        customerName: " ",
        customerId: null,
        lines: [
          { ...line, partNo: null, draft: null },
          {
            ...line,
            lineNo: 2,
            final: { breaks: [{ qty: 50, unitPrice: 0, leadTimeDays: 3 }] },
          },
          {
            ...line,
            lineNo: 3,
            draft: {
              response: response([{ qty: 50, unit_price: null, lead: 1 }]),
            },
          },
        ],
      })
    ).toEqual([
      "Add the customer.",
      "Line 1: add the part number.",
      "Line 1: draft the quote first.",
      "Line 2: every quantity needs a price and a lead time.",
      "Line 3: enter a price for every quantity.",
    ]);
  });
});

describe("the quote the customer gets", () => {
  test("PDF with every line and quantity", async () => {
    const bytes = await renderQuotePdf({
      shop: "Acme Precision",
      reference: "Q-9009 – Q-9010",
      date: "Nov 2, 2026",
      customer: "Northwind Robotics",
      contact: "Dana Ruiz",
      paymentTerms: "Net 30",
      requestedDate: "Dec 4, 2026",
      lines: [
        {
          quoteNo: "Q-9009",
          partNo: "P-1001",
          rev: "B",
          description: "Gripper bracket ≤ 2 kg", // ≤ isn't in the PDF font
          material: "AL6061-T6 bar 2in",
          finish: "Anodize, Type II black",
          breaks: [
            { qty: 50, unitPrice: 43.97, price: 2198.5, leadTimeDays: 3 },
            { qty: 150, unitPrice: 42.44, price: 6366, leadTimeDays: 4 },
          ],
        },
        {
          quoteNo: "Q-9010",
          partNo: "HA-220",
          rev: null,
          description: null,
          material: null,
          finish: null,
          breaks: [{ qty: 25, unitPrice: 88, price: 2200, leadTimeDays: 12 }],
        },
      ],
      notes: ["Your reference: RFQ – gripper brackets"],
    });
    const { extractText, getDocumentProxy } = await import("unpdf");
    const { text } = await extractText(await getDocumentProxy(bytes), {
      mergePages: true,
    });
    for (const expected of [
      "QUOTATION",
      "Q-9009 – Q-9010",
      "Northwind Robotics",
      "Net 30",
      "P-1001 rev B",
      "Gripper bracket ? 2 kg",
      "$43.97",
      "$6,366.00",
      "150",
      "12 days",
      "HA-220",
      "Page 1 of 1",
    ]) {
      expect(text).toContain(expected);
    }
  });

  test("reply email greets the contact and lists every price", () => {
    const email = replyEmail({
      contact: "Dana Ruiz <dana@northwind.example>",
      subject: "RE: RFQ – gripper brackets",
      shop: "Acme Precision",
      reference: "Q-9009",
      lines: [
        {
          quoteNo: "Q-9009",
          partNo: "P-1001",
          rev: "B",
          breaks: [{ qty: 50, unitPrice: 43.97, leadTimeDays: 3 }],
        },
      ],
    });
    expect(email.subject).toBe("Quote Q-9009 – RFQ – gripper brackets");
    expect(email.body).toMatch(/^Hi Dana,/);
    expect(email.body).toContain(
      "P-1001 rev B (Q-9009)\n  - 50 pcs: $43.97/ea, 3 days"
    );
    expect(
      replyEmail({
        contact: null,
        subject: null,
        shop: "A",
        reference: "Q",
        lines: [],
      }).body
    ).toMatch(/^Hello,/);
  });
});
