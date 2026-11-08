import { detectEntity } from "@repo/ingest";
import { describe, expect, test } from "vitest";
import { utils, write } from "xlsx";
import { healthLines, lateReports } from "../lib/erp/health";
import { headerKey, isReport, readSheets } from "../lib/erp/sheets";
import {
  authenticated,
  parseAddress,
  parseAuth,
  senderAllowed,
  sign,
  verifySignature,
} from "../lib/inbound/verify";

const DOMAIN = "in.takumo.ai";
const SECRET = "test-secret-that-is-at-least-32-characters-long";

describe("inbound email: signed delivery from services/mail", () => {
  const body = new TextEncoder().encode(
    "From: reports@shop.example\r\nSubject: Nightly\r\n\r\nhello\r\n"
  );
  const recipients = `erp-abcd1234@${DOMAIN},rfq-zz99yy88xx@${DOMAIN}`;

  test("matches the mail receiver's fixed test vector byte for byte", () => {
    // services/mail/README.md, computed independently with openssl.
    expect(
      sign(
        "test-secret-0123456789abcdef0123456789",
        "1793577600",
        recipients,
        "reports@shop.example",
        body
      )
    ).toBe("8af88ee0dff44d0f5d57747d6f5972bc7f142d0ec8ed7afdf0ee81845875a76d");
  });

  test("accepts a fresh, correct signature; refuses tampering, age and none", () => {
    const now = 1_793_577_600;
    const ok = sign(SECRET, String(now), recipients, "a@b.com", body);
    const base = {
      secret: SECRET,
      recipients,
      mailFrom: "a@b.com",
      body,
      nowSeconds: now,
    };
    expect(
      verifySignature({ ...base, timestamp: String(now), signature: ok }).ok
    ).toBe(true);
    expect(
      verifySignature({
        ...base,
        body: new TextEncoder().encode("changed"),
        timestamp: String(now),
        signature: ok,
      })
    ).toEqual({ ok: false, error: "Bad signature." });
    expect(
      verifySignature({
        ...base,
        recipients: `erp-other1234@${DOMAIN}`,
        timestamp: String(now),
        signature: ok,
      }).ok
    ).toBe(false);
    expect(
      verifySignature({
        ...base,
        timestamp: String(now),
        nowSeconds: now + 301,
        signature: ok,
      })
    ).toEqual({ ok: false, error: "Signature expired." });
    expect(
      verifySignature({ ...base, timestamp: null, signature: null }).ok
    ).toBe(false);
    expect(
      verifySignature({ ...base, timestamp: String(now), signature: "zz" }).ok
    ).toBe(false);
  });

  test("only the shop's own addresses on our domain", () => {
    expect(parseAddress(`ERP-K3J9X2M4P7Q1@${DOMAIN}`, DOMAIN)).toEqual({
      kind: "erp",
      token: "k3j9x2m4p7q1",
    });
    expect(parseAddress(`rfq-abcd1234@${DOMAIN}`, DOMAIN)?.kind).toBe("rfq");
    expect(parseAddress("erp-abcd1234@evil.com", DOMAIN)).toBeNull();
    expect(parseAddress(`erp-short@${DOMAIN}`, DOMAIN)).toBeNull();
    expect(parseAddress(`sales@${DOMAIN}`, DOMAIN)).toBeNull();
    // Documents by email (F6.2) and questions (F3.4).
    expect(parseAddress(`docs-abcd1234@${DOMAIN}`, DOMAIN)?.kind).toBe("docs");
    expect(parseAddress(`ask-abcd1234@${DOMAIN}`, DOMAIN)?.kind).toBe("ask");
  });

  test("senders: exact addresses and whole domains", () => {
    const allowed = ["reports@acme.com", "@epicor-cloud.com", "partner.com"];
    expect(senderAllowed("Reports <REPORTS@acme.com>", allowed)).toBe(true);
    expect(senderAllowed("other@acme.com", allowed)).toBe(false);
    expect(senderAllowed("noreply@epicor-cloud.com", allowed)).toBe(true);
    expect(senderAllowed("x@partner.com", allowed)).toBe(true);
    expect(senderAllowed("x@notpartner.com", allowed)).toBe(false);
    expect(senderAllowed(null, allowed)).toBe(false);
    expect(senderAllowed("reports@acme.com", [])).toBe(false);
  });

  test("a forged From fails; DMARC, aligned DKIM or aligned SPF pass", () => {
    const none = parseAuth(null);
    expect(none).toMatchObject({ spf: "none", dkim: "none", dmarc: "none" });
    // DMARC vouches only for the From domain the mail service read (M3).
    expect(
      authenticated(
        parseAuth('{"dmarc":"pass","from":"Al <a@acme.com>"}'),
        "a@acme.com",
        ""
      )
    ).toBe(true);
    expect(authenticated(parseAuth('{"dmarc":"pass"}'), "a@acme.com", "")).toBe(
      false
    );
    expect(
      authenticated(
        parseAuth('{"dmarc":"pass","from":"x@evil.test"}'),
        "a@acme.com",
        ""
      )
    ).toBe(false);
    expect(
      authenticated(
        parseAuth('{"dkim":"pass","dkimDomains":["acme.com"]}'),
        "a@acme.com",
        ""
      )
    ).toBe(true);
    // Signed, but by someone else's domain.
    expect(
      authenticated(
        parseAuth('{"dkim":"pass","dkimDomains":["mailer.com"]}'),
        "a@acme.com",
        ""
      )
    ).toBe(false);
    expect(
      authenticated(
        parseAuth('{"spf":"pass"}'),
        "a@acme.com",
        "bounce@mail.acme.com"
      )
    ).toBe(true);
    expect(
      authenticated(parseAuth('{"spf":"pass"}'), "a@acme.com", "x@evil.com")
    ).toBe(false);
    expect(
      authenticated(parseAuth("not json"), "a@acme.com", "a@acme.com")
    ).toBe(false);
  });
});

describe("ERP reports by email", () => {
  test("CSV and Excel attachments read into sheets, header row found below a title", () => {
    const csv = new TextEncoder().encode(
      "Open Jobs Report - 11/02/2026\n\nJob,Part,Qty,Due Date\nJ-1,P-2001,300,2026-11-20\nJ-2,P-1001,50,2026-11-25\n"
    );
    const [sheet] = readSheets("Open Jobs.csv", csv);
    expect(sheet.headers).toEqual(["Job", "Part", "Qty", "Due Date"]);
    expect(sheet.rows).toHaveLength(2);

    const book = utils.book_new();
    utils.book_append_sheet(
      book,
      utils.aoa_to_sheet([
        ["Item", "Warehouse", "On Hand", "UOM"],
        ["AL6061-T6 bar 2in", "Main", 120, "ft"],
      ]),
      "Stock"
    );
    const xlsx = new Uint8Array(
      write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer
    );
    const [stock] = readSheets("stock.xlsx", xlsx);
    expect(stock.rows[0]).toMatchObject({
      Item: "AL6061-T6 bar 2in",
      "On Hand": 120,
    });
    expect(isReport("stock.xlsx")).toBe(true);
    expect(isReport("logo.png")).toBe(false);
  });

  test("the same report is recognised whatever the column order or spacing", () => {
    expect(headerKey(["Job", "Part", "Qty"])).toBe(
      headerKey([" qty", "PART", "Job "])
    );
    expect(headerKey(["Job", "Part", "Qty"])).not.toBe(
      headerKey(["Job", "Part"])
    );
  });

  test("new report types are detected from typical ERP headers", () => {
    expect(
      detectEntity(["Item", "Warehouse", "On Hand", "Allocated", "UOM"])
    ).toBe("stock");
    expect(
      detectEntity([
        "PO Number",
        "Line",
        "Vendor",
        "Item",
        "Qty Ordered",
        "Promise Date",
      ])
    ).toBe("purchaseOrders");
    expect(detectEntity(["Employee Name", "Machines", "Labor Rate"])).toBe(
      "operators"
    );
    // Existing types still win their own reports.
    expect(
      detectEntity(["Order No", "Part No", "Qty", "Due Date", "Customer"])
    ).toBe("orders");
  });

  test("a nightly report is late after 26 hours; paused ones never are", () => {
    const now = new Date("2026-11-03T15:00:00Z");
    const at = (iso: string | null) => (iso ? new Date(iso) : null);
    const reports = [
      {
        name: "Open jobs",
        status: "active",
        lastReceivedAt: at("2026-11-03T02:00:00Z"),
        lastImportAt: at("2026-11-03T02:01:00Z"),
        updatedAt: at("2026-10-01T00:00:00Z") as Date,
      },
      {
        name: "Stock",
        status: "active",
        lastReceivedAt: at("2026-11-01T02:00:00Z"),
        lastImportAt: at("2026-11-01T02:01:00Z"),
        updatedAt: at("2026-10-01T00:00:00Z") as Date,
      },
      {
        name: "POs",
        status: "paused",
        lastReceivedAt: at("2026-10-01T02:00:00Z"),
        lastImportAt: at("2026-10-01T02:01:00Z"),
        updatedAt: at("2026-10-01T00:00:00Z") as Date,
      },
      {
        name: "Just confirmed",
        status: "active",
        lastReceivedAt: null,
        lastImportAt: null,
        updatedAt: at("2026-11-03T10:00:00Z") as Date,
      },
    ];
    const late = lateReports(reports, now);
    expect(late.map((r) => r.name)).toEqual(["Stock"]);
    expect(healthLines(late, ["Outlook (quotes@acme.com)"], now)).toEqual([
      "• Stock: last received 2 days ago. Check the ERP's scheduled report or the mail rule that sends it.",
      "• Outlook (quotes@acme.com): the connection stopped working. Reconnect it.",
    ]);
  });

  test("a report that arrives every night but can't be read is late too", () => {
    const now = new Date("2026-11-03T15:00:00Z");
    const renamed = {
      name: "Open orders",
      status: "active",
      // Arrived last night; its last good import was three days ago.
      lastReceivedAt: new Date("2026-11-03T02:00:00Z"),
      lastImportAt: new Date("2026-10-31T02:01:00Z"),
      updatedAt: new Date("2026-10-01T00:00:00Z"),
    };
    const late = lateReports([renamed], now);
    expect(late).toHaveLength(1);
    expect(healthLines(late, [], now)).toEqual([
      "• Open orders: it arrives but hasn't imported since 3 days ago. A column may have been renamed in your ERP: check this report's columns.",
    ]);
  });
});
