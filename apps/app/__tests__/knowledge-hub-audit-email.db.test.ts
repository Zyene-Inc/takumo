// @vitest-environment node
// This file: M3, L8 and the system viewer. C1 and M1 are in
// knowledge-hub-audit-ask.db.test.ts (same setup).
// Security audit regressions (Knowledge Hub phase 4), Ask Takumo on the web
// and by email: C1 (query_data error messages quoted other shops' values and
// restricted facts), M1 (two documents with the same name collapsed in an
// answer's provenance, so revoking one didn't hide the answer), M3 (an
// encoded-word From display name, two From headers or DMARC for another
// domain let someone ask as a member), L8 (a U& identifier hid a query over
// facts from provenance), and the system viewer's facts. These are the
// auditor's exploit steps, asserting they now fail. The model is a scripted,
// adversarial mock that repeats every tool result; nothing reaches a real AI
// provider, WorkOS or email service. Restricted access is switched off in
// code; these tests switch it on. Needs TEST_DATABASE_URL and
// TEST_ASK_DATABASE_URL (the read-only takumo_reader login).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const READER = process.env.TEST_ASK_DATABASE_URL;
process.env.ASK_DATABASE_URL = READER;
process.env.SKIP_ENV_VALIDATION = "true";

// Words that only appear where they must not leak from (letters only:
// snippets drop punctuation, and digits could turn up in ids).
const HR_WORD = "zebrapayband";
const HR_POLICY = "zebraovertimeband";
const B_WORD = "axolotlorder";
const DIM = 1024;
const unit = (k: number): number[] =>
  Array.from({ length: DIM }, (_, i) => (i === k ? 1 : 0));
/** The database's own error words, which can quote a row's value. */

interface Step {
  text?: string;
  tools?: { name: string; input: object }[];
}

const h = vi.hoisted(() => ({
  session: { orgId: null, userId: null, role: null } as {
    orgId: string | null;
    userId: string | null;
    role: string | null;
  },
  members: new Map<string, string>(),
  prompts: [] as string[],
  script: [] as Step[],
  emails: [] as { to: string; subject: string; text: string }[],
  queryVector: null as number[] | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("../../../packages/database/node_modules/server-only", () => ({}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../lib/billing", () => ({ featureProblem: async () => null }));
vi.mock("../lib/ai-usage", () => ({
  recordUsage: async () => undefined,
  recordFailedUsage: async () => undefined,
  budgetProblem: async () => null,
}));
vi.mock("../env", () => ({
  env: {
    INBOUND_EMAIL_DOMAIN: "in.test",
    NEXT_PUBLIC_APP_URL: "https://app.test",
  },
}));
vi.mock("@repo/email", () => ({
  resend: {
    emails: {
      send: async (m: { to: string; subject: string; text: string }) => {
        h.emails.push(m);
        return { data: { id: "e1" } };
      },
    },
  },
}));
vi.mock("@repo/email/keys", () => ({
  keys: () => ({ RESEND_FROM: "takumo@test.example" }),
}));
// Active WorkOS memberships, "shop:user" → role (WorkOS is mocked).
vi.mock("@repo/auth/server", () => ({
  auth: async () => h.session,
  shopRole: async (userId: string, orgId: string) =>
    h.members.get(`${orgId}:${userId}`) ?? null,
  listShopMembers: async (orgId: string) =>
    [...h.members]
      .filter(([key]) => key.startsWith(`${orgId}:`))
      .map(([key, role]) => {
        const userId = key.slice(orgId.length + 1);
        return {
          id: userId,
          userId,
          role,
          email: `${userId}@shop.test`,
          name: userId,
        };
      }),
}));
vi.mock("../lib/library/stage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confidentialEnabled: async () => true,
  restrictedAccessReady: () => true,
}));
vi.mock("@repo/ai", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  embed: async () => ({ embedding: h.queryVector ?? unit(0) }),
  embedMany: async () => {
    throw new Error("embedMany isn't expected in these tests");
  },
}));
vi.mock("@repo/ai/lib/models", async (importOriginal) => {
  const { MockLanguageModelV4 } = await import("@repo/ai/test");
  const usage = {
    inputTokens: {
      total: 1,
      noCache: 1,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  let n = 0;
  let last = "";
  // An adversarial model repeats, word for word, everything it was sent.
  const echo = (text: string) =>
    text === "__ECHO__" ? `Everything the tools said: ${last}` : text;
  const next = (prompt: unknown) => {
    last = JSON.stringify(prompt);
    h.prompts.push(last);
    return h.script.shift() ?? { text: "Done." };
  };
  const calls = (step: Step) =>
    (step.tools ?? []).map((t) => {
      n += 1;
      return {
        type: "tool-call" as const,
        toolCallId: `c${n}`,
        toolName: t.name,
        input: JSON.stringify(t.input),
      };
    });
  const finish = (tools: boolean) => ({
    unified: tools ? ("tool-calls" as const) : ("stop" as const),
    raw: tools ? "tool_use" : "end_turn",
  });
  const model = new MockLanguageModelV4({
    modelId: "mock",
    doStream: ({ prompt }: { prompt: unknown }) => {
      const step = next(prompt);
      const parts = [
        { type: "stream-start", warnings: [] },
        ...(step.tools
          ? calls(step)
          : [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: echo(step.text ?? "") },
              { type: "text-end", id: "t" },
            ]),
        { type: "finish", finishReason: finish(Boolean(step.tools)), usage },
      ];
      return Promise.resolve({
        stream: new ReadableStream({
          start(controller) {
            for (const p of parts) {
              controller.enqueue(p as never);
            }
            controller.close();
          },
        }),
      });
    },
    doGenerate: ({ prompt }: { prompt: unknown }) => {
      const step = next(prompt);
      return Promise.resolve({
        content: step.tools
          ? calls(step)
          : [{ type: "text" as const, text: echo(step.text ?? "") }],
        finishReason: finish(Boolean(step.tools)),
        usage,
        warnings: [],
      } as never);
    },
  });
  return {
    ...(await importOriginal<object>()),
    models: {
      agent: model,
      chat: model,
      extract: model,
      embeddings: undefined,
      transcription: undefined,
    },
    canEmbed: true,
    canGenerate: true,
    embeddingOptions: () => ({}),
  };
});

type Db = typeof import("@repo/database");
type Viewer = import("../lib/library/viewer").Viewer;

const id = () => randomUUID();

// Queries an attacker (or a planted instruction) would have the model send:
// each fails on the first value it can't cast. Before the fix the error
// quoted that value, even another shop's or a restricted fact's.

describe.skipIf(!(TEST_DATABASE_URL && READER))(
  "security audit: Ask on the web and by email (C1, M1, M3, L8)",
  () => {
    const A = `org_audit_ask_a_${id().slice(0, 8)}`;
    const B = `org_audit_ask_b_${id().slice(0, 8)}`;
    let database: Db["database"];
    let viewers: typeof import("../lib/library/viewer");
    let tools: typeof import("../lib/agent/tools");
    let aiAccess: typeof import("../lib/library/ai-access");
    let provenance: typeof import("../lib/library/provenance");
    let brief: typeof import("../lib/brief/load");
    let inbound: typeof import("../lib/inbound/process");
    let inboundAsk: typeof import("../lib/inbound/ask");
    let inboundDocs: typeof import("../lib/inbound/docs");
    let verify: typeof import("../lib/inbound/verify");
    let parse: typeof import("../lib/quotes/email");

    const dept = { hr: id(), eng: id() };
    const folder = { general: id(), hr: id() };
    const doc = { pub: "", hr: "", polHr: "", polPub: "" };
    const token = { ask: "", docs: "" };
    let partId = "";
    let hrFactId = "";
    const today = new Date().toISOString().slice(0, 10);

    const sqlOn = () => {
      process.env.ASK_SQL_ENABLED = "true";
    };
    const sqlOff = () => {
      Reflect.deleteProperty(process.env, "ASK_SQL_ENABLED");
    };

    const as = async (userId: string): Promise<Viewer> => {
      const v = await viewers.viewerForMember(A, userId);
      if (!v) {
        throw new Error(`${userId} isn't a member`);
      }
      return v;
    };

    /** A current, searchable document (no pipeline), .docx-like: no pages. */
    const addDoc = async (
      name: string,
      folderId: string,
      body: string,
      vector = unit(0)
    ) => {
      const sourceId = id();
      const versionId = id();
      await database.source.create({
        data: {
          id: sourceId,
          orgId: A,
          name,
          type: "upload",
          profile: "document",
          folderId,
          status: "ready",
          uploadedBy: "user_owner",
        },
      });
      await database.documentVersion.create({
        data: {
          id: versionId,
          orgId: A,
          sourceId,
          number: 1,
          name: `${name}.docx`,
          status: "ready",
          stage: "done",
          activatedAt: new Date(),
        },
      });
      await database.source.update({
        where: { id: sourceId },
        data: { currentVersionId: versionId, versionSeq: 1 },
      });
      await database.docChunk.createMany({
        data: [
          {
            orgId: A,
            sourceId,
            versionId,
            ordinal: 0,
            content: `${name}: card.`,
            meta: { kind: "card", docType: "other", links: [] },
          },
          {
            orgId: A,
            sourceId,
            versionId,
            ordinal: 1,
            content: body,
            meta: {},
          },
        ],
      });
      await database.$executeRawUnsafe(
        `update "DocChunk" set embedding = $1::vector where "sourceId" = $2`,
        `[${vector.join(",")}]`,
        sourceId
      );
      return sourceId;
    };

    /** ERP data for the SQL reader: one of each, named by the shop. */
    const seedErp = async (orgId: string, name: (what: string) => string) => {
      const customer = await database.customer.create({
        data: { orgId, name: name("CUSTOMER") },
      });
      const machine = await database.workCenter.create({
        data: { orgId, name: name("MACHINE") },
      });
      const part = await database.part.create({
        data: { orgId, partNo: name("PART"), customerId: customer.id },
      });
      await database.routing.create({
        data: {
          orgId,
          partId: part.id,
          seq: 10,
          workCenterId: machine.id,
          setupMin: 30,
          runMinPerUnit: 2,
        },
      });
      const order = await database.order.create({
        data: {
          orgId,
          orderNo: name("ORDER"),
          partId: part.id,
          customerId: customer.id,
          qty: 5,
          dueDate: new Date("2026-12-01"),
        },
      });
      await database.job.create({
        data: {
          orgId,
          orderId: order.id,
          routingSeq: 10,
          workCenterId: machine.id,
        },
      });
      await database.calendarDay.create({
        data: {
          orgId,
          workCenterId: machine.id,
          date: new Date("2026-12-02"),
          availableHours: 4,
        },
      });
    };

    /** POST to the real route; the streamed body and the saved answer. */

    /** A raw message to one of shop A's addresses. */
    const rawEmail = (
      fromLines: string[],
      to: string,
      subject: string,
      body = "Which machines and customers are there?"
    ) =>
      new TextEncoder().encode(
        `${fromLines.map((f) => `From: ${f}\r\n`).join("")}To: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${id()}@shop.test>\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`
      );

    /** Through the real receiveMessage and processMessage, as the webhook does. */
    const deliver = async (input: {
      raw: Uint8Array;
      to: string;
      auth: Partial<import("../lib/inbound/verify").InboundAuth>;
      mailFrom: string;
      script?: Step[];
    }) => {
      h.script = [...(input.script ?? [])];
      h.prompts.length = 0;
      h.emails.length = 0;
      const got = await inbound.receiveMessage({
        auth: {
          spf: "none",
          dkim: "none",
          dkimDomains: [],
          dmarc: "none",
          from: null,
          ...input.auth,
        },
        mailFrom: input.mailFrom,
        raw: input.raw,
        recipients: [input.to],
      });
      if (got.ok) {
        for (const a of got.accepted) {
          await inbound.processMessage(a, input.raw);
        }
      }
      return {
        got,
        emails: [...h.emails],
        emailText: JSON.stringify(h.emails),
        prompts: h.prompts.join("\n"),
      };
    };

    const askAddress = () => `ask-${token.ask}@in.test`;

    /** Shop A's conversations and messages (what the person sees later). */

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      ({ database } = await import("@repo/database"));
      viewers = await import("../lib/library/viewer");
      tools = await import("../lib/agent/tools");
      aiAccess = await import("../lib/library/ai-access");
      provenance = await import("../lib/library/provenance");
      brief = await import("../lib/brief/load");
      inbound = await import("../lib/inbound/process");
      inboundAsk = await import("../lib/inbound/ask");
      inboundDocs = await import("../lib/inbound/docs");
      verify = await import("../lib/inbound/verify");
      parse = await import("../lib/quotes/email");

      for (const [u, r] of [
        ["user_owner", "admin"],
        ["user_eng", "planner"],
        ["user_hr", "member"],
      ]) {
        h.members.set(`${A}:${u}`, r);
      }
      h.members.set(`${B}:user_b_owner`, "admin");

      await database.org.create({
        data: {
          id: A,
          name: "Audit shop A",
          ownerUserId: "user_owner",
          libraryStage: "confidential",
        },
      });
      await database.org.create({
        data: { id: B, name: "Audit shop B", ownerUserId: "user_b_owner" },
      });
      await database.department.createMany({
        data: [
          { id: dept.hr, orgId: A, name: "Human Resources" },
          { id: dept.eng, orgId: A, name: "Engineering" },
        ],
      });
      await database.departmentMember.createMany({
        data: [
          { orgId: A, departmentId: dept.hr, userId: "user_hr" },
          { orgId: A, departmentId: dept.eng, userId: "user_eng" },
        ],
      });
      await database.folder.createMany({
        data: [
          { id: folder.general, orgId: A, name: "General" },
          {
            id: folder.hr,
            orgId: A,
            name: "HR",
            confidential: true,
            inheritAccess: false,
          },
        ],
      });
      await database.accessGrant.createMany({
        data: [
          {
            orgId: A,
            folderId: folder.general,
            principalType: "everyone",
            capabilities: 7,
          },
          {
            orgId: A,
            folderId: folder.hr,
            principalType: "department",
            principalId: dept.hr,
            capabilities: 31,
          },
        ],
      });
      doc.pub = await addDoc(
        "Deburring SOP",
        folder.general,
        "Deburr all edges after op 20."
      );
      doc.hr = await addDoc(
        "Payroll 2026",
        folder.hr,
        `Employee compensation and salary bands: ${HR_WORD} $95,000.`
      );
      // Same name in two folders (names are unique per folder), no pages:
      // their citations share one id ("doc Policy").
      doc.polHr = await addDoc(
        "Policy",
        folder.hr,
        `Policy okapiovertime okapiovertime: overtime pay bands ${HR_POLICY}.`,
        unit(5)
      );
      doc.polPub = await addDoc(
        "Policy",
        folder.general,
        "Policy okapiovertime: overtime needs a supervisor's approval.",
        unit(5).map((v, i) => (i === 6 ? 1 : v * 0.5))
      );

      await seedErp(A, (what) => `A-${what}`);
      await seedErp(B, (what) => `ORGB-${B_WORD}-${what}`);
      partId = (
        await database.part.create({ data: { orgId: A, partNo: "P-SEC" } })
      ).id;
      // Ordinary, company-visible knowledge.
      await database.fact.create({
        data: {
          orgId: A,
          number: 99,
          subjectType: "part",
          subjectId: partId,
          subjectLabel: "P-SEC rev A",
          attribute: "note",
          value: "42",
          source: "note",
          status: "approved",
          provenance: "none",
        },
      });
      // A pending fact read from the HR document only.
      hrFactId = (
        await database.fact.create({
          data: {
            orgId: A,
            number: 1,
            subjectType: "part",
            subjectId: partId,
            subjectLabel: "P-SEC rev A",
            attribute: "note",
            value: `Salary note ${HR_WORD}`,
            evidence: `"${HR_WORD}" (Payroll 2026)`,
            source: "document",
            status: "pending",
            provenance: "documents",
            sources: {
              create: [{ orgId: A, sourceId: doc.hr, quote: HR_WORD }],
            },
          },
        })
      ).id;
      token.ask = `askaudit${id().slice(0, 8)}`;
      token.docs = `docsaudit${id().slice(0, 8)}`;
      await database.inboundAddress.createMany({
        data: [
          { orgId: A, kind: "ask", token: token.ask },
          { orgId: A, kind: "docs", token: token.docs },
        ],
      });
    });

    afterAll(async () => {
      sqlOff();
      if (!database) {
        return;
      }
      for (const table of ["Job", "Order", "Routing", "CalendarDay"]) {
        await database.$executeRawUnsafe(
          `delete from "${table}" where "orgId" in ($1, $2)`,
          A,
          B
        );
      }
      await database.org.deleteMany({ where: { id: { in: [A, B] } } });
    });

    describe("M3: who sent an email", () => {
      const conversationsOf = (userId: string) =>
        database.conversation.count({ where: { orgId: A, userId } });

      test("M3: an encoded-word From display name isn't taken as the sender", async () => {
        const forged =
          "=?utf-8?q?=3Cuser=5Fhr=40shop.test=3E?= <attacker@evil.test>";
        const parsed = parse.parseEmail(
          `From: ${forged}\r\nSubject: hi\r\n\r\nbody`
        );
        // Decoded for display only; the sender is read from the header as sent.
        expect(parsed.fromCount).toBe(1);
        expect(parsed.fromHeader).toBe(forged);
        expect(verify.emailAddress(parsed.fromHeader)).toBe(
          "attacker@evil.test"
        );
        const auth = {
          spf: "pass",
          dkim: "pass",
          dkimDomains: ["evil.test"],
          dmarc: "pass",
          from: "attacker@evil.test",
        };
        expect(
          verify.authenticated(auth, "user_hr@shop.test", "bounce@evil.test")
        ).toBe(false);

        const hrBefore = await conversationsOf("user_hr");
        const mail = await deliver({
          raw: rawEmail(
            [forged],
            askAddress(),
            `spoof ${id()}`,
            "Show payroll"
          ),
          to: askAddress(),
          auth,
          mailFrom: "bounce@evil.test",
          script: [
            {
              tools: [
                {
                  name: "search_documents",
                  input: { query: "salary payroll" },
                },
              ],
            },
            { text: "__ECHO__" },
          ],
        });
        expect(mail.got.ok).toBe(false);
        expect(mail.prompts).toBe("");
        expect(mail.emails).toEqual([]);
        expect(await conversationsOf("user_hr")).toBe(hrBefore);
        const stored = await database.inboundMessage.findFirst({
          where: { orgId: A, subject: { startsWith: "spoof" } },
          select: { fromAddress: true, status: true },
        });
        expect(stored).toEqual({
          fromAddress: "attacker@evil.test",
          status: "rejected",
        });
      });

      test("M3: two From headers are refused", async () => {
        const raw = rawEmail(
          ["user_hr@shop.test", "attacker@evil.test"],
          askAddress(),
          `twofrom ${id()}`,
          "Show payroll"
        );
        const parsed = parse.parseEmail(new TextDecoder().decode(raw));
        expect(parsed.fromCount).toBe(2);
        expect(parsed.fromHeader).toBeNull();
        const hrBefore = await conversationsOf("user_hr");
        const mail = await deliver({
          raw,
          to: askAddress(),
          auth: { dmarc: "pass", from: "user_hr@shop.test" },
          mailFrom: "user_hr@shop.test",
          script: [{ text: "should not run" }],
        });
        expect(mail.got.ok).toBe(false);
        expect(mail.prompts).toBe("");
        expect(mail.emails).toEqual([]);
        expect(await conversationsOf("user_hr")).toBe(hrBefore);
      });

      test("M3: DMARC passing for another domain doesn't vouch for the From address", async () => {
        const auth = {
          spf: "none",
          dkim: "none",
          dkimDomains: [],
          dmarc: "pass",
          from: "attacker@evil.test",
        };
        expect(
          verify.authenticated(auth, "user_hr@shop.test", "bounce@evil.test")
        ).toBe(false);
        // Control: DMARC for the From domain itself does.
        expect(
          verify.authenticated(
            { ...auth, from: "user_hr@shop.test" },
            "user_hr@shop.test",
            "bounce@evil.test"
          )
        ).toBe(true);
        const hrBefore = await conversationsOf("user_hr");
        const mail = await deliver({
          raw: rawEmail(
            ["HR <user_hr@shop.test>"],
            askAddress(),
            `dmarc ${id()}`,
            "Show payroll"
          ),
          to: askAddress(),
          auth,
          mailFrom: "bounce@evil.test",
          script: [{ text: "should not run" }],
        });
        expect(mail.got).toMatchObject({ ok: false, status: 403 });
        expect(mail.got.ok ? "" : mail.got.error).toContain("Couldn't verify");
        expect(mail.prompts).toBe("");
        expect(mail.emails).toEqual([]);
        expect(await conversationsOf("user_hr")).toBe(hrBefore);
      });

      test("M3: email Ask and Docs act for the stored, verified sender, not the header", async () => {
        h.prompts.length = 0;
        h.emails.length = 0;
        // Stored as received from the engineer; the header claims HR.
        const forgedHeader = (to: string, subject: string) =>
          rawEmail(["HR <user_hr@shop.test>"], to, subject, "Show payroll");
        const askMessage = await database.inboundMessage.create({
          data: {
            orgId: A,
            kind: "ask",
            sha256: id(),
            fromAddress: "user_eng@shop.test",
            subject: "stored",
            status: "received",
          },
        });
        const hrBefore = await conversationsOf("user_hr");
        const engBefore = await conversationsOf("user_eng");
        h.script = [{ text: "Answer for the engineer." }];
        await inboundAsk.processAsk(
          A,
          askMessage.id,
          forgedHeader(askAddress(), `stored ${id()}`)
        );
        expect(h.emails.map((e) => e.to)).toEqual(["user_eng@shop.test"]);
        expect(await conversationsOf("user_hr")).toBe(hrBefore);
        expect(await conversationsOf("user_eng")).toBe(engBefore + 1);

        // No verified sender stored (refused on arrival): nothing runs.
        h.prompts.length = 0;
        h.emails.length = 0;
        const refused = await database.inboundMessage.create({
          data: {
            orgId: A,
            kind: "ask",
            sha256: id(),
            fromAddress: null,
            subject: "refused",
            status: "received",
          },
        });
        h.script = [{ text: "should not run" }];
        await inboundAsk.processAsk(
          A,
          refused.id,
          forgedHeader(askAddress(), `refused ${id()}`)
        );
        expect(h.prompts).toEqual([]);
        expect(h.emails).toEqual([]);
        expect(await conversationsOf("user_hr")).toBe(hrBefore);
        expect(
          (
            await database.inboundMessage.findUnique({
              where: { id: refused.id },
              select: { status: true },
            })
          )?.status
        ).toBe("rejected");

        // The docs address the same way: the header names the owner.
        const docsMessage = await database.inboundMessage.create({
          data: {
            orgId: A,
            kind: "docs",
            sha256: id(),
            fromAddress: null,
            subject: "docs",
            status: "received",
          },
        });
        const sourcesBefore = await database.source.count({
          where: { orgId: A },
        });
        await inboundDocs.processDocs(
          A,
          docsMessage.id,
          rawEmail(
            ["Owner <user_owner@shop.test>"],
            `docs-${token.docs}@in.test`,
            `docs ${id()}`
          )
        );
        expect(h.emails).toEqual([]);
        expect(await database.source.count({ where: { orgId: A } })).toBe(
          sourcesBefore
        );
        expect(
          (
            await database.inboundMessage.findUnique({
              where: { id: docsMessage.id },
              select: { status: true },
            })
          )?.status
        ).toBe("rejected");
      });
    });

    test("L8: query_data over facts written with a U& identifier counts as a bulk fact read", async () => {
      // A pending fact read from the public document: a bulk read of the
      // facts view can show it, so its document counts.
      const pub = await database.fact.create({
        data: {
          orgId: A,
          number: 50,
          subjectType: "part",
          subjectId: partId,
          subjectLabel: "P-SEC rev A",
          attribute: "note",
          value: "public note",
          source: "document",
          status: "pending",
          provenance: "documents",
          sources: { create: [{ orgId: A, sourceId: doc.pub }] },
        },
      });
      sqlOn();
      try {
        const all = tools.createTools(
          tools.agentContext(await as("user_eng"), today)
        );
        const run = (sql: string) =>
          (
            all.query_data.execute as unknown as (
              i: unknown,
              o: unknown
            ) => Promise<unknown>
          )({ purpose: "x", sql }, { toolCallId: "x", messages: [] });
        const of = async (sql: string) =>
          provenance.answerProvenance(A, id(), [
            { tool: "query_data", input: { sql }, output: await run(sql) },
          ]);
        const viaName = await of("select fact_no, value from facts");
        expect(viaName.documentIds).toContain(doc.pub);
        for (const sql of [
          String.raw`select fact_no, value from U&"\0066acts"`,
          String.raw`select fact_no, value from u&"\0066\0061cts"`,
          `select fact_no, value from U&"!0066acts" uescape '!'`,
        ]) {
          const viaEscape = await of(sql);
          expect({ sql, ids: viaEscape.documentIds }).toEqual({
            sql,
            ids: expect.arrayContaining([doc.pub]),
          });
          expect(viaEscape.provenance).toBe(viaName.provenance);
        }
        // Control: a query that doesn't read facts doesn't count them.
        expect(
          (await of("select name from customers")).documentIds
        ).not.toContain(doc.pub);
      } finally {
        sqlOff();
        await database.fact.delete({ where: { id: pub.id } });
      }
    });

    test("factAccess, the brief and the system viewer never show the HR-sourced pending fact", async () => {
      const sys = viewers.systemViewer(A);
      expect([...(await aiAccess.factAccess(sys)).keys()]).not.toContain(
        hrFactId
      );
      expect(await aiAccess.visibleFactIds(sys)).not.toContain(hrFactId);
      expect([
        ...(await aiAccess.factAccess(await as("user_eng"))).keys(),
      ]).not.toContain(hrFactId);
      // Control: the HR member, who may open its document, sees it.
      expect([
        ...(await aiAccess.factAccess(await as("user_hr"))).keys(),
      ]).toContain(hrFactId);
      const shopBrief = await brief.loadShopBrief(
        A,
        today,
        new Date(),
        new Set(["facts"]) as Parameters<typeof brief.loadShopBrief>[3]
      );
      expect(shopBrief.facts.top.map((f) => f.id)).not.toContain(hrFactId);
      expect(JSON.stringify(shopBrief)).not.toContain(HR_WORD);
    });
  }
);
