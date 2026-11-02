import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  adminConsentUrl,
  authorizeUrl,
  canReadMail,
  createDraftReply,
  createSubscription,
  exchangeCode,
  firstDeltaUrl,
  handleNotification,
  mailbox,
  needsAdminConsent,
  OUTLOOK_SCOPES,
  OutlookAuthError,
  OutlookConsentError,
  OutlookDeltaExpired,
  pkceVerifier,
  previewMessages,
  rawMessage,
  readDelta,
  refreshTokens,
  renewSubscription,
  rfqMessages,
  subscriptionAction,
} from "../lib/connectors/outlook";
import { isRfqSubject } from "../lib/connectors/rfq-rules";
import { readRfqFile } from "../lib/quotes/read";

const SHARED_MAILBOX = /rfq@shop\.example/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

type Call = [string, RequestInit];
const calls = (fetcher: ReturnType<typeof vi.fn>) =>
  fetcher.mock.calls as unknown as Call[];
const headers = (init: RequestInit) => init.headers as Record<string, string>;

const creds = {
  clientId: "client-1",
  clientSecret: "secret-1",
  redirectUri: "https://app.example/api/connectors/outlook/callback",
};

describe("Outlook sign-in", () => {
  test("the sign-in link asks for mail access on the common endpoint, with PKCE", () => {
    const verifier = pkceVerifier(randomBytes(32), "state-1");
    const url = new URL(
      authorizeUrl("client-1", creds.redirectUri, "state-1", verifier)
    );
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client-1",
      response_type: "code",
      redirect_uri: creds.redirectUri,
      response_mode: "query",
      state: "state-1",
      prompt: "select_account",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "offline_access",
      "https://graph.microsoft.com/User.Read",
      "https://graph.microsoft.com/Mail.ReadWrite",
      "https://graph.microsoft.com/Mail.ReadWrite.Shared",
    ]);
  });

  test("the PKCE verifier is the same for the same state, and secret", () => {
    const key = randomBytes(32);
    expect(pkceVerifier(key, "s")).toBe(pkceVerifier(key, "s"));
    expect(pkceVerifier(key, "s")).not.toBe(pkceVerifier(randomBytes(32), "s"));
    // RFC 7636: 43 to 128 characters.
    expect(pkceVerifier(key, "s")).toHaveLength(43);
  });

  test("the admin-consent link uses the organizations endpoint", () => {
    const url = new URL(
      adminConsentUrl(
        "client-1",
        "https://app.example/api/connectors/outlook/admin-consent"
      )
    );
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/organizations/v2.0/adminconsent"
    );
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example/api/connectors/outlook/admin-consent"
    );
    expect(url.searchParams.get("scope")).toBe(OUTLOOK_SCOPES.join(" "));
  });

  test("tenant consent blocks are told apart from a person saying no", () => {
    expect(needsAdminConsent("consent_required", null)).toBe(true);
    expect(
      needsAdminConsent(
        "access_denied",
        "AADSTS65001: The user or administrator has not consented to use the application"
      )
    ).toBe(true);
    expect(
      needsAdminConsent(
        "access_denied",
        "AADSTS90094: The grant requires admin permission."
      )
    ).toBe(true);
    expect(
      needsAdminConsent(
        "access_denied",
        "AADSTS65004: User declined to consent to access the app."
      )
    ).toBe(false);
    expect(needsAdminConsent("access_denied", null)).toBe(false);
  });

  test("the code exchange sends the secret, verifier and scopes as a form", async () => {
    const fetcher = vi.fn(async () =>
      json({
        access_token: "a",
        refresh_token: "r",
        expires_in: 3599,
        scope: "Mail.ReadWrite Mail.ReadWrite.Shared User.Read profile openid",
      })
    );
    const tokens = await exchangeCode(
      fetcher as typeof fetch,
      creds,
      "code-1",
      "verifier-1"
    );
    expect(tokens).toMatchObject({ access_token: "a", refresh_token: "r" });
    expect(canReadMail(tokens.scope)).toBe(true);
    const [url, init] = calls(fetcher)[0];
    expect(url).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    );
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      grant_type: "authorization_code",
      client_id: "client-1",
      client_secret: "secret-1",
      redirect_uri: creds.redirectUri,
      code: "code-1",
      code_verifier: "verifier-1",
      scope: OUTLOOK_SCOPES.join(" "),
    });
  });

  test("a refresh returns the rotated refresh token", async () => {
    const fetcher = vi.fn(async () =>
      json({ access_token: "a2", refresh_token: "r2", expires_in: 3599 })
    );
    const tokens = await refreshTokens(fetcher as typeof fetch, creds, "r1");
    expect(tokens.refresh_token).toBe("r2");
    const body = calls(fetcher)[0][1].body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("r1");
  });

  test("a consent error at the token endpoint asks for an admin; others mean reconnect", async () => {
    const consent = vi.fn(async () =>
      json(
        {
          error: "invalid_grant",
          error_description:
            "AADSTS65001: The user or administrator has not consented.",
        },
        400
      )
    );
    await expect(
      refreshTokens(consent as typeof fetch, creds, "r")
    ).rejects.toBeInstanceOf(OutlookConsentError);
    const revoked = vi.fn(async () =>
      json({ error: "invalid_grant", error_description: "AADSTS70008" }, 400)
    );
    await expect(
      refreshTokens(revoked as typeof fetch, creds, "r")
    ).rejects.toBeInstanceOf(OutlookAuthError);
  });

  test("granted scopes are read in any of Microsoft's spellings", () => {
    expect(
      canReadMail(
        "https%3A%2F%2Fgraph.microsoft.com%2FMail.ReadWrite offline_access"
      )
    ).toBe(true);
    expect(canReadMail("User.Read offline_access")).toBe(false);
    expect(canReadMail(undefined)).toBe(false);
  });
});

describe("Outlook mail", () => {
  test("the mailbox is the account's address, or its sign-in name", async () => {
    const fetcher = vi.fn(async () =>
      json({ mail: null, userPrincipalName: "est@shop.example" })
    );
    expect(await mailbox(fetcher as typeof fetch, "tok")).toBe(
      "est@shop.example"
    );
    const [url, init] = calls(fetcher)[0];
    expect(url).toBe(
      "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName"
    );
    expect(headers(init).Authorization).toBe("Bearer tok");
  });

  test("the first delta asks for new Inbox mail since a moment, own or shared", () => {
    const since = new Date("2026-10-30T12:00:00.000Z");
    const own = firstDeltaUrl(null, since);
    expect(own).toBe(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?changeType=created&$select=subject%2Cfrom%2CreceivedDateTime%2ChasAttachments%2CisDraft%2CconversationId&$filter=receivedDateTime%20ge%202026-10-30T12%3A00%3A00Z"
    );
    expect(firstDeltaUrl("rfq@shop.example", since)).toContain(
      "/v1.0/users/rfq%40shop.example/mailFolders/inbox/messages/delta?"
    );
  });

  test("a delta round follows next links to the delta link, dropping removals", async () => {
    const pages: Record<string, unknown> = {
      "https://graph.microsoft.com/v1.0/start": {
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/page2",
        value: [{ id: "a", subject: "RFQ 1" }],
      },
      "https://graph.microsoft.com/v1.0/page2": {
        "@odata.deltaLink":
          "https://graph.microsoft.com/v1.0/delta?$deltatoken=x",
        value: [{ id: "b", "@removed": { reason: "deleted" } }, { id: "c" }],
      },
    };
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      json(pages[String(url)])
    );
    const round = await readDelta(
      fetcher as typeof fetch,
      "tok",
      "https://graph.microsoft.com/v1.0/start"
    );
    expect(round.messages.map((m) => m.id)).toEqual(["a", "c"]);
    expect(round.deltaLink).toBe(
      "https://graph.microsoft.com/v1.0/delta?$deltatoken=x"
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(headers(calls(fetcher)[0][1]).Prefer).toBe(
      'odata.maxpagesize=50, IdType="ImmutableId"'
    );
  });

  test("an expired delta link is reported so the round can start over", async () => {
    const fetcher = vi.fn(async () => json({ error: { code: "x" } }, 410));
    await expect(
      readDelta(fetcher as typeof fetch, "tok", "https://g/delta")
    ).rejects.toBeInstanceOf(OutlookDeltaExpired);
  });

  test("a shared mailbox the person can't open is named in the error", async () => {
    const fetcher = vi.fn(async () => json({}, 403));
    await expect(
      readDelta(
        fetcher as typeof fetch,
        "tok",
        firstDeltaUrl("rfq@shop.example", new Date()),
        "rfq@shop.example"
      )
    ).rejects.toThrow(SHARED_MAILBOX);
  });

  test("an expired token is an auth error", async () => {
    const fetcher = vi.fn(async () => json({}, 401));
    await expect(mailbox(fetcher as typeof fetch, "t")).rejects.toBeInstanceOf(
      OutlookAuthError
    );
  });

  test("RFQs are picked by subject like Gmail's search, oldest first, never drafts or own mail", () => {
    const picked = rfqMessages(
      [
        {
          id: "late",
          subject: "RE: RFQ-2211 brackets",
          receivedDateTime: "2026-11-02T10:00:00Z",
          from: { emailAddress: { address: "buyer@acme.example" } },
        },
        {
          id: "early",
          subject: "Request for Quotation: housings",
          receivedDateTime: "2026-11-01T10:00:00Z",
          from: { emailAddress: { address: "buyer@acme.example" } },
        },
        { id: "lunch", subject: "Lunch on Friday?" },
        { id: "draft", subject: "RFQ 9", isDraft: true },
        {
          id: "own",
          subject: "Please quote",
          from: { emailAddress: { address: "RFQ@shop.example" } },
        },
      ],
      "rfq@shop.example"
    );
    expect(picked.map((m) => m.id)).toEqual(["early", "late"]);
  });

  test("the subject rule matches whole words only", () => {
    expect(isRfqSubject("RFQ#42 for brackets")).toBe(true);
    expect(isRfqSubject("Quote request - 6061 plates")).toBe(true);
    expect(isRfqSubject("please  quote these")).toBe(true);
    expect(isRfqSubject("Our RFQs policy")).toBe(false);
    expect(isRfqSubject("Request for quotes")).toBe(false);
    expect(isRfqSubject(null)).toBe(false);
  });

  test("a message's MIME is read like an uploaded .eml", async () => {
    const eml = readFileSync(
      path.join(import.meta.dirname, "../evals/rfqs/northwind-brackets.eml")
    );
    const fetcher = vi.fn(async () => new Response(eml));
    const raw = await rawMessage(fetcher as typeof fetch, "tok", "AAk/id=");
    expect(calls(fetcher)[0][0]).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/AAk%2Fid%3D/$value"
    );
    expect(headers(calls(fetcher)[0][1]).Prefer).toBe('IdType="ImmutableId"');
    const rfq = await readRfqFile("message.eml", raw);
    expect(rfq.subject).toBe("RFQ NW-2211 gripper brackets");
  });

  test("the preview lists the last 20 Inbox emails and marks RFQs", async () => {
    const fetcher = vi.fn(async () =>
      json({
        value: [
          {
            id: "2",
            subject: "Invoice 88",
            receivedDateTime: "2026-11-02T09:00:00Z",
            from: { emailAddress: { address: "ap@vendor.example" } },
          },
          {
            id: "1",
            subject: "RFQ: 400 pcs",
            receivedDateTime: "2026-11-01T09:00:00Z",
            from: { emailAddress: { address: "buyer@acme.example" } },
          },
        ],
      })
    );
    const rows = await previewMessages(
      fetcher as typeof fetch,
      "tok",
      "est@shop.example"
    );
    expect(rows.map((r) => [r.id, r.isRfq])).toEqual([
      ["2", false],
      ["1", true],
    ]);
    expect(calls(fetcher)[0][0]).toBe(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$select=subject%2Cfrom%2CreceivedDateTime%2ChasAttachments%2CisDraft%2CconversationId&$orderby=receivedDateTime%20desc&$top=20"
    );
  });

  test("a reply draft is created, then our text goes above the quoted RFQ", async () => {
    const fetcher = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/createReply")) {
        return Promise.resolve(
          json(
            {
              id: "draft-1",
              webLink: "https://outlook.office.com/draft-1",
              body: { contentType: "html", content: "<div>quoted</div>" },
            },
            201
          )
        );
      }
      return Promise.resolve(
        json({ id: "draft-1", ...JSON.parse(String(init?.body)) })
      );
    });
    const draft = await createDraftReply(
      fetcher as typeof fetch,
      "tok",
      "msg-1",
      "<p>Our quote</p>"
    );
    expect(draft).toEqual({
      id: "draft-1",
      webLink: "https://outlook.office.com/draft-1",
      conversationId: null,
    });
    const [create, update] = calls(fetcher);
    expect(create[0]).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/msg-1/createReply"
    );
    expect(create[1].method).toBe("POST");
    expect(update[0]).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/draft-1"
    );
    expect(update[1].method).toBe("PATCH");
    expect(JSON.parse(String(update[1].body))).toEqual({
      body: {
        contentType: "html",
        content: "<p>Our quote</p><div>quoted</div>",
      },
    });
  });

  test("a plain-text quote is escaped under the reply", async () => {
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) =>
        String(url).endsWith("/createReply")
          ? json({ id: "d", body: { contentType: "text", content: "a<b" } })
          : json(JSON.parse(String(init?.body)))
    );
    await createDraftReply(
      fetcher as typeof fetch,
      "tok",
      "m",
      "<p>x</p>",
      "rfq@shop.example"
    );
    const [create, update] = calls(fetcher);
    expect(create[0]).toContain("/users/rfq%40shop.example/messages/m/");
    expect(JSON.parse(String(update[1].body)).body.content).toBe(
      "<p>x</p><pre>a&lt;b</pre>"
    );
  });
});

describe("Outlook notifications", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const hours = (h: number) => new Date(now + h * 3_600_000).toISOString();

  test("subscriptions are created, kept, renewed within a day, or removed", () => {
    const on = { canNotify: true };
    expect(subscriptionAction(null, on, now)).toBe("create");
    expect(subscriptionAction({ expiresAt: hours(100) }, on, now)).toBe("keep");
    expect(subscriptionAction({ expiresAt: hours(23) }, on, now)).toBe("renew");
    // Expired: Microsoft already deleted it.
    expect(subscriptionAction({ expiresAt: hours(-1) }, on, now)).toBe(
      "create"
    );
    // Delegated access can't subscribe to a shared mailbox.
    expect(
      subscriptionAction(
        { expiresAt: hours(100) },
        { canNotify: true, sharedMailbox: "rfq@shop.example" },
        now
      )
    ).toBe("remove");
    expect(subscriptionAction(null, { canNotify: false }, now)).toBe("keep");
  });

  test("a new subscription watches the Inbox for new mail, under 7 days", async () => {
    const fetcher = vi.fn(async () =>
      json({ id: "sub-1", expirationDateTime: "2026-11-09T10:40:00Z" }, 201)
    );
    const sub = await createSubscription(
      fetcher as typeof fetch,
      "tok",
      "https://app.example/api/connectors/outlook/notify",
      "secret-state",
      now
    );
    expect(sub).toEqual({ id: "sub-1", expiresAt: "2026-11-09T10:40:00Z" });
    const [url, init] = calls(fetcher)[0];
    expect(url).toBe("https://graph.microsoft.com/v1.0/subscriptions");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      changeType: "created",
      notificationUrl: "https://app.example/api/connectors/outlook/notify",
      resource: "/me/mailFolders('inbox')/messages",
      expirationDateTime: new Date(now + 10_000 * 60_000).toISOString(),
      clientState: "secret-state",
    });
    expect(Date.parse(body.expirationDateTime) - now).toBeLessThan(
      10_080 * 60_000
    );
  });

  test("renewing a subscription Microsoft dropped says so", async () => {
    const gone = vi.fn(async () => json({}, 404));
    expect(
      await renewSubscription(gone as typeof fetch, "tok", "s", now)
    ).toBeNull();
    const ok = vi.fn(async () => json({ expirationDateTime: "later" }));
    expect(await renewSubscription(ok as typeof fetch, "tok", "s", now)).toBe(
      "later"
    );
    expect(calls(ok)[0][1].method).toBe("PATCH");
  });

  const deps = (schedule = vi.fn()) => ({
    schedule,
    lookup: vi.fn(async (id: string) =>
      id === "sub-1" ? { orgId: "org_1", clientState: "right-state" } : null
    ),
  });

  test("the validation handshake echoes the token as plain text", async () => {
    const d = deps();
    const response = await handleNotification(
      new Request(
        "https://app.example/api/connectors/outlook/notify?validationToken=Validation%3A%20Testing%20client%20application",
        { method: "POST" }
      ),
      d
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8"
    );
    expect(await response.text()).toBe(
      "Validation: Testing client application"
    );
    expect(d.lookup).not.toHaveBeenCalled();
  });

  const notify = (value: unknown) =>
    new Request("https://app.example/api/connectors/outlook/notify", {
      method: "POST",
      body: JSON.stringify({ value }),
    });

  test("a genuine notification is acknowledged and checks that shop's inbox", async () => {
    const d = deps();
    const response = await handleNotification(
      notify([
        { subscriptionId: "sub-1", clientState: "right-state" },
        { subscriptionId: "sub-1", clientState: "right-state" },
      ]),
      d
    );
    expect(response.status).toBe(202);
    expect(d.schedule).toHaveBeenCalledWith(["org_1"]);
  });

  test("a wrong or missing clientState is ignored", async () => {
    const d = deps();
    const response = await handleNotification(
      notify([
        { subscriptionId: "sub-1", clientState: "wrong-state" },
        { subscriptionId: "sub-1" },
        { subscriptionId: "sub-2", clientState: "right-state" },
      ]),
      d
    );
    expect(response.status).toBe(202);
    expect(d.schedule).not.toHaveBeenCalled();
  });

  test("a body that isn't JSON is refused", async () => {
    const response = await handleNotification(
      new Request("https://app.example/n", { method: "POST", body: "nope" }),
      deps()
    );
    expect(response.status).toBe(400);
  });
});
