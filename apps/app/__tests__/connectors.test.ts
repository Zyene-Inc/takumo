import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  decrypt,
  encrypt,
  parseKey,
  signState,
  verifyState,
} from "../lib/connectors/crypto";
import * as gmail from "../lib/connectors/gmail";
import * as qb from "../lib/connectors/quickbooks";
import { readRfqFile } from "../lib/quotes/read";

const key = randomBytes(32);

describe("connector secrets", () => {
  test("encrypt and decrypt round-trip; each sealing is different", () => {
    const a = encrypt(key, "refresh-token-123");
    const b = encrypt(key, "refresh-token-123");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1:")).toBe(true);
    expect(a).not.toContain("refresh-token");
    expect(decrypt(key, a)).toBe("refresh-token-123");
  });

  test("tampering or the wrong key is refused", () => {
    const sealed = encrypt(key, "secret");
    const parts = sealed.split(":");
    parts[3] = Buffer.from("other").toString("base64url");
    expect(() => decrypt(key, parts.join(":"))).toThrow();
    expect(() => decrypt(randomBytes(32), sealed)).toThrow();
    expect(() => decrypt(key, "plain-token")).toThrow(/Not an encrypted/);
  });

  test("the key must be 32 bytes", () => {
    expect(parseKey(key.toString("base64")).length).toBe(32);
    expect(() => parseKey(undefined)).toThrow(/32 bytes/);
    expect(() => parseKey(Buffer.alloc(16).toString("base64"))).toThrow(
      /32 bytes/
    );
  });
});

describe("OAuth state", () => {
  const who = { orgId: "org_1", userId: "user_1", provider: "gmail" };
  const now = Date.parse("2026-11-02T12:00:00Z");

  test("a fresh state from this server verifies", () => {
    const token = signState(key, who, now);
    expect(verifyState(key, token, now + 60_000)).toMatchObject(who);
  });

  test("forged, expired or garbled states are refused", () => {
    const token = signState(key, who, now);
    expect(verifyState(randomBytes(32), token, now)).toBeNull();
    expect(verifyState(key, token, now + 16 * 60_000)).toBeNull();
    const [body] = token.split(".");
    const other = Buffer.from(
      JSON.stringify({ ...who, orgId: "org_2", exp: now + 60_000, nonce: "x" })
    ).toString("base64url");
    expect(verifyState(key, `${other}.${token.split(".")[1]}`, now)).toBeNull();
    expect(verifyState(key, body, now)).toBeNull();
    expect(verifyState(key, "", now)).toBeNull();
  });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("QuickBooks", () => {
  test("the sign-in link asks for accounting access and carries the state", () => {
    const url = new URL(
      qb.authorizeUrl("client-1", "https://app/cb", "state-1")
    );
    expect(url.origin + url.pathname).toBe(qb.QB_AUTHORIZE_URL);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client-1",
      redirect_uri: "https://app/cb",
      response_type: "code",
      scope: "com.intuit.quickbooks.accounting",
      state: "state-1",
    });
  });

  test("customers keep their payment terms; inactive ones are skipped", () => {
    const records = qb.customerRecords(
      [
        {
          Id: "1",
          DisplayName: "Bluefin Marine",
          SalesTermRef: { value: "3" },
        },
        { Id: "2", DisplayName: "Harbor Automation" },
        { Id: "3", DisplayName: "Old Co", Active: false },
      ],
      [{ Id: "3", DueDays: 45 }]
    );
    expect(records.map((r) => r.values)).toEqual([
      { name: "Bluefin Marine", paymentTermDays: 45 },
      { name: "Harbor Automation" },
    ]);
  });

  test("estimates become past quotes, linked to shop parts only", () => {
    const records = qb.estimateRecords(
      [
        {
          Id: "10",
          DocNumber: "1042",
          TxnDate: "2026-09-14",
          TxnStatus: "Accepted",
          TotalAmt: 4650,
          CustomerRef: { value: "1", name: "Bluefin Marine" },
          Line: [
            {
              DetailType: "SalesItemLineDetail",
              Amount: 150,
              SalesItemLineDetail: {
                ItemRef: { value: "9", name: "Setup charge" },
                Qty: 1,
              },
            },
            {
              DetailType: "SalesItemLineDetail",
              Amount: 4500,
              SalesItemLineDetail: {
                ItemRef: { value: "4", name: "Machined:P-2001" },
                Qty: 40,
              },
            },
            { DetailType: "SubTotalLineDetail", Amount: 4650 },
          ],
        },
        {
          Id: "11",
          TxnDate: "2026-10-01",
          TxnStatus: "Rejected",
          TotalAmt: 900,
          Line: [
            {
              DetailType: "SalesItemLineDetail",
              Amount: 900,
              SalesItemLineDetail: {
                ItemRef: { value: "7", name: "Custom bracket" },
                Qty: 12,
              },
            },
          ],
        },
        {
          Id: "12",
          DocNumber: "1044",
          TxnStatus: "Pending",
          Line: [{ DetailType: "SubTotalLineDetail", Amount: 0 }],
        },
      ],
      ["P-2001", "P-1001"]
    );
    expect(records.map((r) => r.values)).toEqual([
      {
        quoteNo: "1042",
        qty: 40,
        customer: "Bluefin Marine",
        partNo: "P-2001",
        price: 4650,
        status: "won",
        quotedAt: "2026-09-14",
      },
      // No shop part: the biggest line's quantity, no part (never invented).
      {
        quoteNo: "QB-11",
        qty: 12,
        customer: null,
        partNo: null,
        price: 900,
        status: "lost",
        quotedAt: "2026-10-01",
      },
    ]);
  });

  test("queries page through every row", async () => {
    const fetcher = vi.fn(
      async (url: string | URL | Request, _init?: RequestInit) => {
        const query = new URL(String(url)).searchParams.get("query") ?? "";
        const start = Number(query.match(/startposition (\d+)/)?.[1]);
        const rows =
          start === 1
            ? Array.from({ length: 1000 }, (_, i) => ({ Id: String(i) }))
            : [{ Id: "last" }];
        return json({ QueryResponse: { Customer: rows } });
      }
    );
    const rows = await qb.queryAll<{ Id: string }>(
      fetcher as typeof fetch,
      "sandbox",
      "realm 1",
      "tok",
      "Customer"
    );
    expect(rows).toHaveLength(1001);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const first = String(fetcher.mock.calls[0][0]);
    expect(
      first.startsWith(
        "https://sandbox-quickbooks.api.intuit.com/v3/company/realm%201/query?"
      )
    ).toBe(true);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: "Bearer tok" },
    });
  });

  test("an expired token is an auth error (reconnect)", async () => {
    const fetcher = vi.fn(async () => json({}, 401));
    await expect(
      qb.queryAll(fetcher as typeof fetch, "production", "r", "t", "Estimate")
    ).rejects.toBeInstanceOf(qb.QbAuthError);
  });

  test("the code exchange uses HTTP basic auth", async () => {
    const fetcher = vi.fn(async () =>
      json({ access_token: "a", refresh_token: "r", expires_in: 3600 })
    );
    const tokens = await qb.exchangeCode(
      fetcher as typeof fetch,
      { clientId: "id", clientSecret: "secret", redirectUri: "https://app/cb" },
      "code-1"
    );
    expect(tokens.refresh_token).toBe("r");
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(qb.QB_TOKEN_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("id:secret").toString("base64")}`
    );
    expect(String(init.body)).toBe(
      "grant_type=authorization_code&code=code-1&redirect_uri=https%3A%2F%2Fapp%2Fcb"
    );
  });
});

describe("Gmail", () => {
  test("the sign-in link asks for read-only mail and a refresh token", () => {
    const url = new URL(gmail.authorizeUrl("client-1", "https://app/cb", "s"));
    expect(url.searchParams.get("scope")).toBe(`${gmail.GMAIL_SCOPE} email`);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  test("only new mail is searched", () => {
    const since = new Date("2026-11-01T00:00:00Z");
    expect(gmail.searchFor(null, since)).toBe(
      `${gmail.DEFAULT_RFQ_QUERY} after:1793491200`
    );
    expect(gmail.searchFor("label:rfq", since)).toBe(
      "label:rfq after:1793491200"
    );
  });

  test("a message from Gmail is read like an uploaded .eml, attachments included", async () => {
    const eml = readFileSync(
      path.join(import.meta.dirname, "../evals/rfqs/northwind-brackets.eml")
    );
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/messages?")) {
        return json({ messages: [{ id: "m2" }, { id: "m1" }] });
      }
      return json({ raw: eml.toString("base64url") });
    });
    const ids = await gmail.listMessages(fetcher as typeof fetch, "tok", "q");
    expect(ids).toEqual(["m2", "m1"]);
    const raw = await gmail.rawMessage(fetcher as typeof fetch, "tok", "m1");
    const rfq = await readRfqFile("message.eml", raw);
    expect(rfq.source).toBe("email");
    expect(rfq.subject).toBe("RFQ NW-2211 gripper brackets");
    expect(rfq.body).toContain("Quantities: 50 / 150 / 400");
  });

  test("an expired token is an auth error", async () => {
    const fetcher = vi.fn(async () => json({}, 401));
    await expect(
      gmail.mailbox(fetcher as typeof fetch, "t")
    ).rejects.toBeInstanceOf(gmail.GmailAuthError);
  });
});
