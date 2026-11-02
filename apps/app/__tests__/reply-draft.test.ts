import { describe, expect, test, vi } from "vitest";
import {
  draftMessage,
  createDraft as gmailCreateDraft,
  newMessageMime,
  replyMime,
  sentInThread,
} from "../lib/connectors/gmail";
import {
  addAttachment,
  createDraftReply,
  draftBody,
  INLINE_ATTACHMENT_BYTES,
  sentInConversation,
  UPLOAD_CHUNK_BYTES,
} from "../lib/connectors/outlook";
import { sentFinal } from "../lib/quotes/approval";
import { quoteDocument, quotedLines } from "../lib/quotes/document";
import { htmlToText, parseEmail } from "../lib/quotes/email";
import { formatHours, median, quoteMetrics } from "../lib/quotes/metrics";
import { settleQuotes } from "../lib/quotes/outcomes";
import {
  type DraftReplyInput,
  draftReply,
  draftStep,
  draftUntouched,
  normalizeBody,
  parseSentPrices,
} from "../lib/quotes/reply";
import type { RfqView } from "../lib/quotes/view";

vi.mock("server-only", () => ({}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const input = (over: Partial<DraftReplyInput> = {}): DraftReplyInput => ({
  contact: "Dana Ortiz <dana@cobalt.example>",
  subject: "RE: RFQ NW-2211 brackets",
  shop: "Ridgeline Machine",
  reference: "Q-1041 – Q-1042",
  intro: null,
  signature: null,
  validityDays: 30,
  questions: ["Is rev C the latest drawing?"],
  pdf: true,
  lines: [
    {
      quoteNo: "Q-1041",
      partNo: "NW-2211",
      rev: "C",
      breaks: [
        { qty: 50, unitPrice: 42.5, leadTimeDays: 15 },
        { qty: 250, unitPrice: 31.2, leadTimeDays: 22 },
      ],
      material: "6061-T6 aluminum",
      finish: "Type II anodize, black",
      tolerances: "±0.005 unless noted",
      questions: ["Is the 0.250 bore a press fit?"],
    },
    {
      quoteNo: "Q-1042",
      partNo: "NW-2212",
      rev: null,
      breaks: [{ qty: 100, unitPrice: 8, leadTimeDays: 10 }],
      material: null,
      finish: null,
      tolerances: null,
      questions: [],
    },
  ],
  ...over,
});

describe("the draft reply", () => {
  test("greets by first name and lists every price with its total and lead time", () => {
    const { subject, text } = draftReply(input());
    expect(subject).toBe("Quote Q-1041 – Q-1042 - RFQ NW-2211 brackets");
    expect(text.startsWith("Hi Dana,")).toBe(true);
    expect(text).toContain("NW-2211 rev C (Q-1041)");
    expect(text).toContain("50 pcs: $42.50/ea, $2,125.00 total, 15 days");
    expect(text).toContain("250 pcs: $31.20/ea, $7,800.00 total, 22 days");
    expect(text).toContain("NW-2212 (Q-1042)");
    expect(text).toContain("attached quote Q-1041 – Q-1042");
  });

  test("states assumptions, asks the questions, and gives validity and signature", () => {
    const { text } = draftReply(
      input({ validityDays: 45, signature: "Sam Lee\nRidgeline Machine" })
    );
    expect(text).toContain(
      "NW-2211 rev C: material 6061-T6 aluminum; finish Type II anodize, black; tolerances ±0.005 unless noted"
    );
    expect(text).toContain("Is rev C the latest drawing?");
    // Several parts: a part's own question says which part it's about.
    expect(text).toContain("NW-2211 rev C: Is the 0.250 bore a press fit?");
    expect(text).toContain("Prices are valid for 45 days.");
    expect(text.trim().endsWith("Sam Lee\nRidgeline Machine")).toBe(true);
    expect(text).not.toContain("Best regards");
  });

  test("never carries anything internal", () => {
    const { text, html } = draftReply(input());
    for (const leak of ["cost", "margin", "Takumo", "/quotes/", "flag"]) {
      expect(text.toLowerCase()).not.toContain(leak.toLowerCase());
      expect(html.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  test("escapes HTML from customer text", () => {
    const { html } = draftReply(
      input({ questions: ["<script>x</script> & more?"] })
    );
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt; &amp; more?");
    expect(html).not.toContain("<script>");
  });

  test("a hello without a usable name", () => {
    const { text } = draftReply(input({ contact: "purchasing@x.com" }));
    expect(text.startsWith("Hello,")).toBe(true);
  });
});

describe("telling whether the estimator edited the draft", () => {
  const ours = normalizeBody(htmlToText(draftReply(input()).html));

  test("the draft as a mail app stores it still matches, quoted original and all", () => {
    const outlook = `<html><body><div style="font-family:Calibri">${draftReply(input()).html.replaceAll("$", "&#36;")}</div><hr><div>From: Dana<br>Sent: Monday</div></body></html>`;
    expect(draftUntouched(htmlToText(outlook), ours)).toBe(true);
  });

  test("any change to Takumo's text counts as an edit", () => {
    const edited = draftReply(input()).html.replace("$42.50", "$41.00");
    expect(draftUntouched(htmlToText(edited), ours)).toBe(false);
  });

  test("replace an unedited draft, keep an edited one, leave a deleted one", () => {
    const next = `${ours} changed`;
    expect(draftStep({ before: null, current: null, mode: "auto", next })).toBe(
      "create"
    );
    expect(
      draftStep({ before: ours, current: ours, mode: "auto", next: ours })
    ).toBe("unchanged");
    expect(draftStep({ before: ours, current: ours, mode: "auto", next })).toBe(
      "replace"
    );
    expect(
      draftStep({ before: ours, current: "edited by Sam", mode: "auto", next })
    ).toBe("add");
    expect(draftStep({ before: ours, current: null, mode: "auto", next })).toBe(
      "skip"
    );
    expect(
      draftStep({ before: ours, current: null, mode: "explicit", next })
    ).toBe("create");
  });
});

describe("reading prices from the reply that was sent", () => {
  const parts = ["NW-2211", "NW-2212"];

  test("Takumo's own format reads back exactly", () => {
    const { text } = draftReply(input());
    expect(parseSentPrices(text, parts)).toEqual([
      { partNo: "NW-2211", qty: 50, unitPrice: 42.5, leadTimeDays: 15 },
      { partNo: "NW-2211", qty: 250, unitPrice: 31.2, leadTimeDays: 22 },
      { partNo: "NW-2212", qty: 100, unitPrice: 8, leadTimeDays: 10 },
    ]);
  });

  test("forms estimators edit prices into", () => {
    const text = [
      "Hi Dana,",
      "NW-2211:",
      "Qty 50 - $40.00 each, 3 weeks",
      "250 @ $1,031.20 ea",
      "",
      "> NW-2212",
      "> 100 pcs: $8.00/ea",
    ].join("\n");
    expect(parseSentPrices(text, parts)).toEqual([
      { partNo: "NW-2211", qty: 50, unitPrice: 40, leadTimeDays: 21 },
      { partNo: "NW-2211", qty: 250, unitPrice: 1031.2, leadTimeDays: null },
    ]);
  });

  test("stops at the quoted original", () => {
    const text = [
      "NW-2211 50 pcs: $40.00/ea, 15 days",
      "On Mon, Nov 2, 2026 at 9:00 AM Dana wrote:",
      "NW-2211 50 pcs: $1.00/ea",
    ].join("\n");
    expect(parseSentPrices(text, ["NW-2211"])).toEqual([
      { partNo: "NW-2211", qty: 50, unitPrice: 40, leadTimeDays: 15 },
    ]);
  });
});

describe("Gmail drafts", () => {
  const pdf = {
    name: 'Quote "Q-1".pdf',
    mediaType: "application/pdf",
    bytes: new Uint8Array([37, 80, 68, 70, 1, 2, 3]),
  };

  test("a reply in the thread carries the quote PDF and the threading headers", () => {
    const raw = replyMime(
      {
        threadId: "t1",
        messageId: "<rfq@buyer.example>",
        references: null,
        subject: "RFQ 12",
        to: "dana@buyer.example",
      },
      "<p>Prices</p>",
      pdf,
      "b1"
    );
    expect(raw).toContain("In-Reply-To: <rfq@buyer.example>\r\n");
    expect(raw).toContain("Subject: Re: RFQ 12\r\n");
    expect(raw).toContain('Content-Type: multipart/mixed; boundary="b1"');
    expect(raw).toContain('filename="Quote Q-1.pdf"');
    const parsed = parseEmail(raw);
    expect(parsed.body).toBe("Prices");
    expect(parsed.attachments).toHaveLength(1);
    expect([...parsed.attachments[0].bytes]).toEqual([...pdf.bytes]);
  });

  test("a new message has no threading headers", () => {
    const raw = newMessageMime(
      { to: "a@b.example", subject: "Quote Q-1" },
      "<p>x</p>",
      null
    );
    expect(raw).not.toContain("In-Reply-To");
    expect(raw).toContain("Subject: Quote Q-1\r\n");
  });

  test("a new draft returns its thread so the sent reply can be found", async () => {
    const fetcher = vi.fn(async () =>
      json({ id: "d2", message: { id: "m2", threadId: "t9" } })
    );
    const draft = await gmailCreateDraft(
      fetcher as unknown as typeof fetch,
      "tok",
      { to: "a@b.example", subject: "Quote" },
      "<p>x</p>",
      pdf
    );
    expect(draft).toEqual({ id: "d2", messageId: "m2", threadId: "t9" });
  });

  test("a deleted or sent draft reads as gone", async () => {
    const fetcher = vi.fn(async () => json({ error: {} }, 404));
    expect(
      await draftMessage(fetcher as unknown as typeof fetch, "tok", "d1")
    ).toBeNull();
  });

  test("the first message sent in the thread after the draft", async () => {
    const after = new Date("2026-11-02T10:00:00Z");
    const fetcher = vi.fn(async () =>
      json({
        messages: [
          { id: "rfq", internalDate: "1793600000000", labelIds: ["INBOX"] },
          {
            id: "early",
            internalDate: String(after.getTime() - 1000),
            labelIds: ["SENT"],
          },
          {
            id: "draft",
            internalDate: String(after.getTime() + 1000),
            labelIds: ["DRAFT", "SENT"],
          },
          {
            id: "sent",
            internalDate: String(after.getTime() + 5000),
            labelIds: ["SENT"],
          },
        ],
      })
    );
    const sent = await sentInThread(
      fetcher as unknown as typeof fetch,
      "tok",
      "t1",
      after
    );
    expect(sent?.id).toBe("sent");
  });
});

describe("Outlook drafts", () => {
  const calls = (fetcher: ReturnType<typeof vi.fn>) =>
    fetcher.mock.calls as unknown as [string, RequestInit][];

  test("the reply draft gets the quote PDF attached", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/createReply")
        ? json({
            id: "d1",
            conversationId: "conv-1",
            body: { contentType: "html", content: "<div>quoted</div>" },
          })
        : json({})
    );
    const draft = await createDraftReply(
      fetcher as unknown as typeof fetch,
      "tok",
      "msg-1",
      "<p>Prices</p>",
      null,
      {
        attachment: {
          name: "Quote.pdf",
          mediaType: "application/pdf",
          bytes: new Uint8Array([1, 2, 3]),
        },
        subject: "RE: RFQ 12 (updated)",
      }
    );
    expect(draft.conversationId).toBe("conv-1");
    const [, patch, attach] = calls(fetcher);
    expect(JSON.parse(String(patch[1].body)).subject).toBe(
      "RE: RFQ 12 (updated)"
    );
    expect(attach[0]).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/d1/attachments"
    );
    const body = JSON.parse(String(attach[1].body));
    expect(body["@odata.type"]).toBe("#microsoft.graph.fileAttachment");
    expect(Buffer.from(body.contentBytes, "base64")).toEqual(
      Buffer.from([1, 2, 3])
    );
  });

  test("a large PDF goes up in pieces through an upload session", async () => {
    const size = INLINE_ATTACHMENT_BYTES + UPLOAD_CHUNK_BYTES + 5;
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/createUploadSession")
        ? json({ uploadUrl: "https://upload.example/s1" })
        : new Response(null, { status: 200 })
    );
    await addAttachment(
      fetcher as unknown as typeof fetch,
      "tok",
      "d1",
      {
        name: "Quote.pdf",
        mediaType: "application/pdf",
        bytes: new Uint8Array(size),
      },
      "rfq@shop.example"
    );
    const [session, ...puts] = calls(fetcher);
    expect(session[0]).toContain(
      "/users/rfq%40shop.example/messages/d1/attachments/createUploadSession"
    );
    expect(puts.every(([u]) => u === "https://upload.example/s1")).toBe(true);
    const ranges = puts.map(
      ([, init]) => (init.headers as Record<string, string>)["Content-Range"]
    );
    expect(ranges[0]).toBe(`bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${size}`);
    expect(ranges.at(-1)).toMatch(new RegExp(`-${size - 1}/${size}$`));
    // The upload URL is pre-authorized: no bearer token sent to it.
    expect(
      (puts[0][1].headers as Record<string, string>).Authorization
    ).toBeUndefined();
  });

  test("a sent or deleted draft reads as gone", async () => {
    const sent = vi.fn(async () =>
      json({ isDraft: false, body: { content: "x" } })
    );
    expect(
      await draftBody(sent as unknown as typeof fetch, "tok", "d1")
    ).toBeNull();
    const gone = vi.fn(async () => json({}, 404));
    expect(
      await draftBody(gone as unknown as typeof fetch, "tok", "d1")
    ).toBeNull();
    const draft = vi.fn(async () =>
      json({ isDraft: true, body: { content: "<p>hi</p>" } })
    );
    expect(await draftBody(draft as unknown as typeof fetch, "tok", "d1")).toBe(
      "<p>hi</p>"
    );
  });

  test("the reply sent in the conversation, from Sent Items", async () => {
    const after = new Date("2026-11-02T10:00:00Z");
    const fetcher = vi.fn(async () =>
      json({
        value: [
          {
            id: "s2",
            sentDateTime: "2026-11-02T12:00:00Z",
            body: { content: "<p>later</p>" },
          },
          {
            id: "s1",
            sentDateTime: "2026-11-02T11:00:00Z",
            body: { content: "<p>first</p>" },
          },
        ],
      })
    );
    const sent = await sentInConversation(
      fetcher as unknown as typeof fetch,
      "tok",
      "conv'1",
      after
    );
    expect(sent?.id).toBe("s1");
    const url = decodeURIComponent(
      String(calls(fetcher)[0][0]).replaceAll("+", " ")
    );
    expect(url).toContain("/me/mailFolders('sentitems')/messages");
    expect(url).toContain("conversationId eq 'conv''1'");
    expect(url).toContain("sentDateTime ge 2026-11-02T10:00:00.000Z");
  });
});

describe("the quote PDF before approval", () => {
  const view = {
    id: "r1",
    label: "RFQ-0012",
    subject: "RFQ 12",
    receivedAt: "2026-11-01T09:00:00.000Z",
    customerName: "Cobalt Medical",
    contact: null,
    paymentTermDays: 30,
    requestedDate: null,
    lines: [
      {
        id: "l1",
        lineNo: 1,
        partNo: "NW-2211",
        rev: "C",
        description: "Bracket",
        materialText: "6061",
        material: null,
        part: null,
        finish: null,
        tolerances: "±0.005",
        quote: null,
        drawing: null,
        sendFinal: { breaks: [{ qty: 10, unitPrice: 5, leadTimeDays: 12 }] },
      },
      {
        id: "l2",
        lineNo: 2,
        partNo: "NW-2212",
        rev: null,
        description: null,
        materialText: null,
        material: null,
        part: null,
        finish: null,
        tolerances: null,
        quote: null,
        drawing: null,
        sendFinal: null,
      },
    ],
  } as unknown as RfqView;

  test("draft lines use the reserved quote numbers; unpriced lines are left out", () => {
    expect(quotedLines(view)).toEqual([]);
    const doc = quoteDocument(view, "Ridgeline", {
      reserved: { l1: "Q-1041", l2: "Q-1042" },
      today: "2026-11-02",
      validityDays: 30,
    });
    expect(doc.lines.map((l) => l.quoteNo)).toEqual(["Q-1041"]);
    expect(doc.lines[0].breaks[0]).toEqual({
      qty: 10,
      unitPrice: 5,
      price: 50,
      leadTimeDays: 12,
    });
    expect(doc.date).toBe("Nov 2, 2026");
    expect(doc.notes).toContain("Prices are valid for 30 days.");
    expect(doc.notes).toContain("NW-2211: quoted to ±0.005.");
  });
});

describe("quotes answered by the ERP", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000);
  const quote = (id: string, since: number, part = "p1") => ({
    id,
    partId: part,
    customerId: "c1",
    since: day(since),
  });
  const order = (no: string, at: number, part = "p1", customer = "c1") => ({
    orderNo: no,
    partId: part,
    customerId: customer,
    qty: 50,
    createdAt: day(at),
  });

  test("an order within 60 days wins the newest matching quote", () => {
    const r = settleQuotes(
      [quote("old", 0), quote("new", 10)],
      [order("SO-1", 20)],
      day(25),
      true
    );
    expect(r.won).toEqual([{ quoteId: "new", orderNo: "SO-1", qty: 50 }]);
    expect(r.lost).toEqual([]);
  });

  test("orders before the quote, after 60 days, or for someone else don't count", () => {
    const r = settleQuotes(
      [quote("q", 10)],
      [
        order("SO-before", 5),
        order("SO-late", 71),
        order("SO-other", 20, "p1", "c2"),
        order("SO-part", 20, "p2"),
      ],
      day(30),
      true
    );
    expect(r.won).toEqual([]);
  });

  test("60 days without an order is lost, only when the ERP sends orders", () => {
    expect(settleQuotes([quote("q", 0)], [], day(61), true).lost).toEqual([
      "q",
    ]);
    expect(settleQuotes([quote("q", 0)], [], day(59), true).lost).toEqual([]);
    expect(settleQuotes([quote("q", 0)], [], day(90), false).lost).toEqual([]);
  });
});

describe("quoting metrics", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 10, 2) + h * 3_600_000);

  test("medians, small edits, win rate and margin", () => {
    const m = quoteMetrics(
      [
        { receivedAt: at(0), draftedAt: at(0.5), sentAt: at(2) },
        { receivedAt: at(0), draftedAt: at(1.5), sentAt: at(6) },
        { receivedAt: at(0), draftedAt: at(4), sentAt: null },
        { receivedAt: at(0), draftedAt: null, sentAt: null },
      ],
      [
        {
          price: 100,
          draftPrice: 102,
          leadTimeDays: 10,
          draftLeadTimeDays: 10,
          estCost: 75,
          status: "won",
        },
        {
          price: 200,
          draftPrice: 150,
          leadTimeDays: 10,
          draftLeadTimeDays: 10,
          estCost: 150,
          status: "lost",
        },
        {
          price: 50,
          draftPrice: 50,
          leadTimeDays: 5,
          draftLeadTimeDays: 5,
          estCost: null,
          status: "open",
        },
      ]
    );
    expect(m.hoursToDraft).toBe(1.5);
    expect(m.hoursToSent).toBe(4);
    expect(m.rfqsDrafted).toBe(3);
    expect(m.rfqsSent).toBe(2);
    expect(m.smallEdits).toEqual({ drafted: 3, accepted: 2, rate: 2 / 3 });
    expect(m.win).toEqual({ won: 1, decided: 2, rate: 0.5 });
    expect(m.margin).toBeCloseTo(0.25);
    expect(m.marginQuotes).toBe(2);
  });

  test("nothing yet reads as no value, not zero", () => {
    const m = quoteMetrics([], []);
    expect(m.hoursToDraft).toBeNull();
    expect(m.win.rate).toBeNull();
    expect(m.margin).toBeNull();
    expect(median([])).toBeNull();
    expect(formatHours(null)).toBe("—");
    expect(formatHours(0.25)).toBe("15 min");
    expect(formatHours(3.46)).toBe("3.5 h");
    expect(formatHours(72)).toBe("3 days");
  });
});

describe("prices captured from the sent reply", () => {
  const line = {
    partNo: "NW-2211",
    qtys: [50, 250],
    draft: null,
    final: {
      breaks: [
        { qty: 50, unitPrice: 42.5, leadTimeDays: 15 },
        { qty: 250, unitPrice: 31.2, leadTimeDays: 22 },
      ],
    },
  };

  test("sent prices replace the draft's; missing lead times keep the draft's", () => {
    expect(
      sentFinal(line, [
        { partNo: "nw-2211", qty: 50, unitPrice: 40, leadTimeDays: null },
      ])
    ).toEqual({
      breaks: [
        { qty: 50, unitPrice: 40, leadTimeDays: 15 },
        { qty: 250, unitPrice: 31.2, leadTimeDays: 22 },
      ],
    });
  });

  test("no prices read for the part: nothing to record", () => {
    expect(
      sentFinal(line, [
        { partNo: "OTHER", qty: 50, unitPrice: 40, leadTimeDays: 3 },
      ])
    ).toBeNull();
  });
});
