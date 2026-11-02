import { describe, expect, it } from "vitest";
import {
  chooseLane,
  freeCheck,
  recognise,
  senderRule,
} from "../lib/quotes/screen";

const DMARC = /DMARC/;
const SPF = /SPF/;
const INVOICE = /Invoice/;

const h = (entries: Record<string, string> = {}) =>
  new Map(Object.entries(entries));
const mail = (over: Partial<Parameters<typeof freeCheck>[0]> = {}) =>
  freeCheck({
    channel: "email",
    from: "Jo Buyer <jo@cobalt-medical.com>",
    headers: h(),
    subject: "RFQ: 3 brackets",
    ...over,
  });

describe("free checks (no AI)", () => {
  it("lets an ordinary email through", () => {
    expect(mail()).toBeNull();
    expect(
      mail({
        headers: h({
          "authentication-results":
            "mx.google.com; dkim=pass; spf=pass; dmarc=pass",
        }),
      })
    ).toBeNull();
  });

  it("stops mail that fails the sender checks", () => {
    expect(
      mail({ headers: h({ "authentication-results": "x; dmarc=fail" }) })
    ).toMatch(DMARC);
    expect(
      mail({
        headers: h({ "authentication-results": "x; spf=fail; dkim=none" }),
      })
    ).toMatch(SPF);
    // SPF fails on a forwarded message but the DKIM signature holds: fine.
    expect(
      mail({
        headers: h({ "authentication-results": "x; spf=fail; dkim=pass" }),
      })
    ).toBeNull();
  });

  it("stops automatic replies, bounces and newsletters", () => {
    expect(mail({ subject: "Automatic reply: RFQ 3 brackets" })).not.toBeNull();
    expect(mail({ subject: "Out of Office" })).not.toBeNull();
    expect(mail({ subject: "Undeliverable: quote" })).not.toBeNull();
    expect(
      mail({ headers: h({ "auto-submitted": "auto-replied" }) })
    ).not.toBeNull();
    expect(
      mail({ headers: h({ "list-unsubscribe": "<mailto:x>" }) })
    ).not.toBeNull();
    expect(mail({ headers: h({ precedence: "bulk" }) })).not.toBeNull();
    expect(mail({ from: "noreply@vendor.com" })).not.toBeNull();
    expect(mail({ from: "mailer-daemon@x.com" })).not.toBeNull();
    expect(mail({ headers: h({ "auto-submitted": "no" }) })).toBeNull();
  });

  it("never drops a portal's notice for being automatic", () => {
    const portal = {
      channel: "portal" as const,
      from: "no-reply@ariba.com",
      headers: h({ "list-unsubscribe": "<x>", precedence: "bulk" }),
      subject: "New RFQ event 1234",
    };
    expect(mail(portal)).toBeNull();
    // But a portal email that fails DMARC is still stopped.
    expect(
      mail({
        ...portal,
        headers: h({ "authentication-results": "dmarc=fail" }),
      })
    ).not.toBeNull();
  });
});

describe("who the sender is", () => {
  const customers = [
    { id: "c1", emails: ["buyer@gmail.com"], domains: ["cobalt-medical.com"] },
  ];
  const known = { customers, senders: [], shopDomain: "acme-machining.com" };

  it("matches customers by address or company domain", () => {
    expect(recognise("Jo <jo@cobalt-medical.com>", known)).toEqual({
      customerId: "c1",
      known: true,
    });
    expect(recognise("buyer@gmail.com", known).customerId).toBe("c1");
  });

  it("never matches a whole shared-mail domain", () => {
    expect(recognise("stranger@gmail.com", known)).toEqual({
      customerId: null,
      known: false,
    });
    expect(
      recognise("stranger@gmail.com", { ...known, shopDomain: "gmail.com" })
        .known
    ).toBe(false);
  });

  it("knows colleagues and learned senders", () => {
    expect(recognise("estimator@acme-machining.com", known).known).toBe(true);
    expect(
      recognise("new@partner.com", { ...known, senders: ["@partner.com"] })
        .known
    ).toBe(true);
    expect(recognise("new@partner.com", known).known).toBe(false);
  });

  it("learns the company domain, or the address on shared mail", () => {
    expect(senderRule("Jo <JO@Cobalt.com>")).toBe("@cobalt.com");
    expect(senderRule("jo@gmail.com")).toBe("jo@gmail.com");
    expect(senderRule(null)).toBeNull();
  });
});

describe("lanes", () => {
  const rfq = {
    isRfq: true,
    confidence: "high",
    summary: "Quote for 3 brackets",
  };
  const notRfq = {
    isRfq: false,
    confidence: "high",
    summary: "Invoice for October",
  };
  const base = {
    blocked: false,
    customerId: null,
    freeProblem: null,
    known: false,
    triage: rfq,
  };

  it("does the full work for a known sender's RFQ", () => {
    expect(chooseLane({ ...base, known: true, customerId: "c1" }).lane).toBe(
      "full"
    );
  });

  it("holds a new sender's RFQ for a person, never drops it", () => {
    expect(chooseLane(base).lane).toBe("new_sender");
    // The check didn't run (limit or error): still kept for a person.
    expect(chooseLane({ ...base, triage: null }).lane).toBe("new_sender");
  });

  it("filters what isn't an RFQ, even from a customer", () => {
    const lane = chooseLane({ ...base, known: true, triage: notRfq });
    expect(lane.lane).toBe("filtered");
    expect(lane.reason).toMatch(INVOICE);
  });

  it("gives a known sender the benefit of a low-confidence doubt", () => {
    const unsure = { ...notRfq, confidence: "low" };
    expect(chooseLane({ ...base, known: true, triage: unsure }).lane).toBe(
      "full"
    );
    expect(chooseLane({ ...base, triage: unsure }).lane).toBe("new_sender");
  });

  it("filters blocked senders and failed free checks first", () => {
    expect(chooseLane({ ...base, known: true, blocked: true }).lane).toBe(
      "filtered"
    );
    expect(
      chooseLane({ ...base, known: true, freeProblem: "An automatic message." })
        .lane
    ).toBe("filtered");
  });
});
