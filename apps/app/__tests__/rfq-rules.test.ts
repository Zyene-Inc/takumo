import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_RFQ_QUERY,
  previewMessages as gmailPreview,
} from "../lib/connectors/gmail";
import {
  firstDeltaUrl,
  type GraphMessage,
  listFolders,
  previewMessages as outlookPreview,
  rfqMessages,
  SUBSCRIPTION_RESOURCE,
  subscriptionResource,
} from "../lib/connectors/outlook";
import {
  allowedSenders,
  cleanTerm,
  DEFAULT_RULES,
  gmailQuery,
  gmailSubjectQuery,
  isRfqSubject,
  knownSenderRules,
  readRules,
  senderPasses,
} from "../lib/connectors/rfq-rules";
import {
  attachmentsHashOf,
  fingerprint,
  mailThreadOf,
} from "../lib/connectors/thread";

const CRLF = "\r\n";
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const eml = (files: { name: string; text: string }[]) =>
  [
    "From: Buyer <buyer@acme.example>",
    "Subject: RFQ 42",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "Please quote.",
    ...files.flatMap((f) => [
      "--b",
      `Content-Type: application/octet-stream; name="${f.name}"`,
      `Content-Disposition: attachment; filename="${f.name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(f.text).toString("base64"),
    ]),
    "--b--",
    "",
  ].join(CRLF);

const bytes = (text: string) => new TextEncoder().encode(text);

describe("RFQ rules", () => {
  test("no rules saved means Takumo's defaults, unchanged", () => {
    expect(readRules(null)).toEqual(DEFAULT_RULES);
    expect(readRules({ query: "x" })).toEqual(DEFAULT_RULES);
    expect(gmailSubjectQuery()).toBe(DEFAULT_RFQ_QUERY);
    expect(gmailQuery(DEFAULT_RFQ_QUERY, DEFAULT_RULES)).toBe(
      DEFAULT_RFQ_QUERY
    );
    expect(allowedSenders(DEFAULT_RULES, ["@acme.example"])).toBeNull();
  });

  test("saved rules are cleaned: odd values dropped, words tidied", () => {
    const rules = readRules({
      rfqRules: {
        extraTerms: ["  Bid   Request ", "bid request", 7, 'x"(y)'],
        senders: [" Buyer@Acme.example ", "@acme.example"],
        requireAttachments: true,
        knownCustomersOnly: "yes",
      },
    });
    expect(rules).toEqual({
      extraTerms: ["bid request", "x y"],
      senders: ["buyer@acme.example", "@acme.example"],
      requireAttachments: true,
      knownCustomersOnly: false,
    });
    expect(cleanTerm("Quote/Bid #")).toBe("quote/bid #");
  });

  test("extra subject words count as whole words, the defaults still do", () => {
    expect(isRfqSubject("Bid request: brackets")).toBe(false);
    expect(isRfqSubject("Bid request: brackets", ["bid request"])).toBe(true);
    expect(isRfqSubject("Bid requests open", ["bid request"])).toBe(false);
    expect(isRfqSubject("RFQ-2211", ["bid request"])).toBe(true);
    expect(isRfqSubject("Anfrage für Drehteile", ["anfrage"])).toBe(true);
  });

  test("the Gmail search takes extra words and the attachment rule", () => {
    const rules = {
      ...DEFAULT_RULES,
      extraTerms: ["bid request", "quotation"],
      requireAttachments: true,
    };
    expect(gmailQuery(null, rules)).toBe(
      'subject:(rfq OR "request for quote" OR "request for quotation" OR "quote request" OR "please quote" OR "bid request" OR quotation) -in:sent -in:chats has:attachment'
    );
    // The shop's own search wins over the words, but still needs attachments.
    expect(gmailQuery("label:rfqs", rules)).toBe("label:rfqs has:attachment");
  });

  test("known customers: company domains, but full addresses on shared ones", () => {
    expect(
      knownSenderRules([
        "Buyer <buyer@acme.example>",
        "pat@acme.example",
        "joe.machinist@gmail.com",
        null,
        "not an address",
      ])
    ).toEqual(["@acme.example", "joe.machinist@gmail.com"]);
  });

  test("the sender filter: anyone, a list, or known customers", () => {
    const listed = { ...DEFAULT_RULES, senders: ["@acme.example"] };
    expect(
      senderPasses("x@other.example", allowedSenders(DEFAULT_RULES, []))
    ).toBe(true);
    expect(senderPasses("b@acme.example", allowedSenders(listed, []))).toBe(
      true
    );
    expect(senderPasses("x@other.example", allowedSenders(listed, []))).toBe(
      false
    );
    const known = { ...DEFAULT_RULES, knownCustomersOnly: true };
    expect(
      senderPasses("x@other.example", allowedSenders(known, ["@other.example"]))
    ).toBe(true);
    // Known customers only, and none yet: nothing gets through.
    expect(senderPasses("x@other.example", allowedSenders(known, []))).toBe(
      false
    );
  });
});

describe("Outlook RFQ rules and folders", () => {
  const messages: GraphMessage[] = [
    {
      id: "a",
      subject: "RFQ no drawing",
      hasAttachments: false,
      receivedDateTime: "2026-11-01T08:00:00Z",
      from: { emailAddress: { address: "buyer@acme.example" } },
    },
    {
      id: "b",
      subject: "Bid request",
      hasAttachments: true,
      receivedDateTime: "2026-11-01T09:00:00Z",
      from: { emailAddress: { address: "buyer@acme.example" } },
    },
    {
      id: "c",
      subject: "RFQ from a stranger",
      hasAttachments: true,
      receivedDateTime: "2026-11-01T10:00:00Z",
      from: { emailAddress: { address: "who@else.example" } },
    },
  ];

  test("rules narrow the messages read into RFQs", () => {
    const own = "est@shop.example";
    expect(rfqMessages(messages, own).map((m) => m.id)).toEqual(["a", "c"]);
    const rules = {
      ...DEFAULT_RULES,
      extraTerms: ["bid request"],
      requireAttachments: true,
    };
    expect(rfqMessages(messages, own, rules).map((m) => m.id)).toEqual([
      "b",
      "c",
    ]);
    expect(
      rfqMessages(messages, own, rules, ["@acme.example"]).map((m) => m.id)
    ).toEqual(["b"]);
  });

  test("a chosen folder is read instead of the Inbox, and watched", () => {
    const since = new Date("2026-11-01T00:00:00Z");
    expect(firstDeltaUrl(null, since)).toContain("/me/mailFolders/inbox/");
    expect(firstDeltaUrl(null, since, "AAMk=")).toContain(
      "/me/mailFolders/AAMk%3D/messages/delta?"
    );
    expect(subscriptionResource(null)).toBe(SUBSCRIPTION_RESOURCE);
    expect(subscriptionResource("inbox")).toBe(SUBSCRIPTION_RESOURCE);
    expect(subscriptionResource("it's")).toBe(
      "/me/mailFolders('it''s')/messages"
    );
  });

  test("the preview reads the chosen folder with the rules", async () => {
    const fetcher = vi.fn(() => Promise.resolve(json({ value: messages })));
    const rows = await outlookPreview(
      fetcher as unknown as typeof fetch,
      "tok",
      "est@shop.example",
      null,
      { folder: "F1", rules: { ...DEFAULT_RULES, requireAttachments: true } }
    );
    expect(rows.map((r) => [r.id, r.isRfq])).toEqual([
      ["a", false],
      ["b", false],
      ["c", true],
    ]);
    expect(String((fetcher.mock.calls[0] as unknown[])[0])).toContain(
      "/me/mailFolders/F1/messages?"
    );
  });

  test("folders are listed with the ones inside them, and the Inbox found", async () => {
    const fetcher = vi.fn((url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/mailFolders/inbox?")) {
        return Promise.resolve(json({ id: "INBOX-ID" }));
      }
      if (u.includes("/childFolders")) {
        return Promise.resolve(
          json({ value: [{ id: "K1", displayName: "RFQs" }] })
        );
      }
      return Promise.resolve(
        json({
          value: [
            { id: "INBOX-ID", displayName: "Posteingang", childFolderCount: 1 },
            { id: "S1", displayName: "Sent Items", childFolderCount: 0 },
          ],
        })
      );
    });
    const result = await listFolders(
      fetcher as unknown as typeof fetch,
      "tok",
      "rfq@shop.example"
    );
    expect(result).toEqual({
      inboxId: "INBOX-ID",
      folders: [
        { id: "INBOX-ID", name: "Posteingang" },
        { id: "K1", name: "Posteingang / RFQs" },
        { id: "S1", name: "Sent Items" },
      ],
    });
    expect(String((fetcher.mock.calls[0] as unknown[])[0])).toContain(
      "/users/rfq%40shop.example/mailFolders?"
    );
  });
});

describe("Gmail preview with sender rules", () => {
  test("a matching email from a sender the rules don't allow is skipped", async () => {
    const fetcher = vi.fn((url: string | URL | Request) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/messages")) {
        return Promise.resolve(
          json({ messages: [{ id: "m1" }, { id: "m2" }] })
        );
      }
      const from = u.pathname.endsWith("/m1")
        ? "Buyer <buyer@acme.example>"
        : "who@else.example";
      return Promise.resolve(
        json({
          payload: {
            headers: [
              { name: "Subject", value: "RFQ" },
              { name: "From", value: from },
            ],
          },
        })
      );
    });
    const rows = await gmailPreview(
      fetcher as unknown as typeof fetch,
      "tok",
      DEFAULT_RFQ_QUERY,
      ["@acme.example"]
    );
    expect(rows.map((r) => [r.id, r.isRfq])).toEqual([
      ["m1", true],
      ["m2", false],
    ]);
  });
});

describe("mail threads", () => {
  test("the attachments fingerprint ignores order and file names", () => {
    const one = fingerprint(
      bytes(
        eml([
          { name: "a.pdf", text: "drawing" },
          { name: "b.step", text: "model" },
        ])
      )
    );
    const two = fingerprint(
      bytes(
        eml([
          { name: "model.step", text: "model" },
          { name: "drawing.pdf", text: "drawing" },
        ])
      )
    );
    expect(one.attachmentsHash).toBe(two.attachmentsHash);
    expect(one.from).toBe("Buyer <buyer@acme.example>");
    expect(
      fingerprint(bytes(eml([{ name: "a.pdf", text: "drawing rev B" }])))
        .attachmentsHash
    ).not.toBe(one.attachmentsHash);
    expect(fingerprint(bytes(eml([]))).attachmentsHash).toBe("none");
    expect(attachmentsHashOf([])).toBe("none");
  });

  test("the thread is read back from an RFQ, ignoring anything else", () => {
    const mail = {
      provider: "outlook",
      threadId: "conv-1",
      attachmentsHash: "none",
    };
    expect(mailThreadOf({ questions: [], mail })).toEqual(mail);
    expect(mailThreadOf({ questions: [] })).toBeNull();
    expect(mailThreadOf({ mail: { provider: "fax" } })).toBeNull();
    expect(mailThreadOf(null)).toBeNull();
  });
});
