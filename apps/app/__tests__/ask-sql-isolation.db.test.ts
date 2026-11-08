// @vitest-environment node
// Security hotfix: Ask Takumo's SQL tool can't show one shop another shop's
// data, on the web (the real /api/ask route) or by email (the real
// processAsk), even when the model is fully adversarial: it sends queries
// built to fail on other shops' values, then repeats every tool result word
// for word. Shop B's values carry a marker that must never appear in what
// the model is sent, the stream, the saved conversation, the email or the
// logs. Needs TEST_DATABASE_URL and TEST_ASK_DATABASE_URL (takumo_reader).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const ADMIN = process.env.TEST_DATABASE_URL;
const READER = process.env.TEST_ASK_DATABASE_URL;
process.env.ASK_DATABASE_URL = READER;

const MARK = "58213";
const RAW_POSTGRES = /invalid input syntax|does not exist|division by zero/;
/** The database's own error words in a text, with some context, or null. */
const rawAround = (text: string) => {
  const at = text.search(RAW_POSTGRES);
  return at < 0 ? null : text.slice(Math.max(0, at - 120), at + 80);
};

const seen = vi.hoisted(() => ({
  prompts: [] as string[],
  emails: [] as string[],
  logs: [] as string[],
  orgId: "",
  userId: "user_hotfix_pat",
}));

vi.mock("server-only", () => ({}));
vi.mock("../../../packages/database/node_modules/server-only", () => ({}));
vi.mock("@repo/observability/log", () => {
  const keep = (...args: unknown[]) => {
    seen.logs.push(JSON.stringify(args));
  };
  return { log: { info: keep, warn: keep, error: keep, debug: keep } };
});
vi.mock("@repo/auth/server", () => ({
  auth: async () => ({ orgId: seen.orgId, userId: seen.userId }),
  listShopMembers: async () => [
    {
      id: "m1",
      userId: seen.userId,
      role: "admin",
      email: "pat@shop-a.example",
      name: "Pat",
    },
  ],
}));
vi.mock("@repo/email", () => ({
  resend: {
    emails: {
      send: (m: { text: string }) => {
        seen.emails.push(m.text);
        return Promise.resolve({ data: { id: "e1" } });
      },
    },
  },
}));
vi.mock("@repo/email/keys", () => ({
  keys: () => ({ RESEND_FROM: "takumo@test.example" }),
}));
vi.mock("../lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../lib/billing", () => ({ featureProblem: async () => null }));
vi.mock("../lib/ai-usage", () => ({
  budgetProblem: async () => null,
  recordUsage: vi.fn(),
  recordFailedUsage: vi.fn(),
}));

// Queries an attacker (or a planted instruction) would have the model send:
// each fails on the first value it can't cast, which before the hotfix
// could be another shop's (see packages/database/__tests__/reader-isolation).
const PROBES = [
  "select part_no from routings where work_center not like 'A-%' and work_center::int > 0",
  "select work_center from calendar where work_center not like 'A-%' and work_center::int > 0",
  "select order_no from jobs where work_center not like 'A-%' and work_center::int > 0",
  "select 1 from parts where customer not like 'A-%' and customer::regclass is not null",
  // Other sessions' SQL, through a function that runs a query of its own:
  // refused before the database (and the wrapper hides it anyway).
  "select query_to_xml('select query from pg_stat_activity', true, false, '')",
  // Shop A's own value in an error isn't passed on either.
  "select name from customers where name::int > 0",
  // A normal query: shop A's own rows come back.
  "select name from customers order by name",
];

vi.mock("@repo/ai/lib/models", async (importOriginal) => {
  const { MockLanguageModelV4 } = await import("@repo/ai/test");
  const usage = {
    inputTokens: {
      total: 10,
      noCache: 10,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
  /** First turn: the probes. After that: every tool result, repeated. */
  const reply = (prompt: unknown) => {
    const text = JSON.stringify(prompt);
    seen.prompts.push(text);
    if (!text.includes('"tool-result"')) {
      return {
        calls: PROBES.map((sql, i) => ({
          type: "tool-call" as const,
          toolCallId: `q${i}`,
          toolName: "query_data",
          input: JSON.stringify({ purpose: `probe ${i}`, sql }),
        })),
        text: null,
      };
    }
    return { calls: [], text: `Everything the tools said: ${text}` };
  };
  const finish = (tools: boolean) => ({
    unified: tools ? ("tool-calls" as const) : ("stop" as const),
    raw: tools ? "tool_use" : "end_turn",
  });
  const model = new MockLanguageModelV4({
    modelId: "mock",
    doGenerate: (options: { prompt: unknown }) => {
      const { calls, text } = reply(options.prompt);
      return Promise.resolve({
        content: text ? [{ type: "text" as const, text }] : calls,
        finishReason: finish(calls.length > 0),
        usage,
        warnings: [],
      });
    },
    doStream: (options: { prompt: unknown }) => {
      const { calls, text } = reply(options.prompt);
      const parts = [
        { type: "stream-start", warnings: [] },
        ...(text
          ? [
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: text },
              { type: "text-end", id: "t" },
            ]
          : calls),
        { type: "finish", finishReason: finish(calls.length > 0), usage },
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
  };
});

type Db = typeof import("@repo/database");

describe.skipIf(!(ADMIN && READER))("Ask Takumo's SQL across shops", () => {
  let db: Db;
  const shopA = `org_hotfix_a_${randomUUID().slice(0, 8)}`;
  const shopB = `org_hotfix_b_${randomUUID().slice(0, 8)}`;

  const seed = async (orgId: string, name: (what: string) => string) => {
    const { database } = db;
    await database.org.create({ data: { id: orgId, name: orgId } });
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

  /** Everything shop A's member could see or the model was sent. */
  const exposed = async (conversationId?: string) => {
    const saved = await db.database.message.findMany({
      where: conversationId
        ? { conversationId }
        : { conversation: { orgId: shopA } },
    });
    return {
      prompts: seen.prompts.join("\n"),
      saved: JSON.stringify(saved),
      emails: seen.emails.join("\n"),
      logs: seen.logs.join("\n"),
    };
  };

  const reset = () => {
    seen.prompts.length = 0;
    seen.emails.length = 0;
    seen.logs.length = 0;
  };

  beforeAll(async () => {
    db = await import("@repo/database");
    await seed(shopA, (what) => `A-${what}`);
    await seed(shopB, (what) => `ORGB-LEAK-${what}-${MARK}`);
    seen.orgId = shopA;
  });

  afterAll(async () => {
    const { database } = db;
    for (const table of ["Job", "Order", "Routing", "CalendarDay"]) {
      await database.$executeRawUnsafe(
        `delete from "${table}" where "orgId" in ($1, $2)`,
        shopA,
        shopB
      );
    }
    await database.org.deleteMany({ where: { id: { in: [shopA, shopB] } } });
  });

  const askOnTheWeb = async () => {
    const { POST } = await import("../app/api/ask/route");
    const conversation = randomUUID();
    const response = await POST(
      new Request("http://test/api/ask", {
        method: "POST",
        body: JSON.stringify({
          id: conversation,
          message: {
            id: randomUUID(),
            role: "user",
            parts: [
              { type: "text", text: "Which machines and customers are there?" },
            ],
          },
          today: new Date().toISOString().slice(0, 10),
          mode: "thorough",
        }),
      })
    );
    expect(response.status).toBe(200);
    const streamed = await response.text();
    // The answer is saved when the stream ends (onEnd).
    for (let i = 0; i < 50; i++) {
      const answers = await db.database.message.count({
        where: { conversationId: conversation, role: "assistant" },
      });
      if (answers > 0) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { streamed, conversation };
  };

  const askByEmail = async () => {
    const { processAsk } = await import("../lib/inbound/ask");
    const raw = new TextEncoder().encode(
      `From: Pat <pat@shop-a.example>\r\nTo: ask@x\r\nSubject: Machines\r\nMessage-ID: <m-${randomUUID()}@shop-a.example>\r\nContent-Type: text/plain\r\n\r\nWhich machines and customers are there?\r\n`
    );
    await processAsk(shopA, randomUUID(), raw);
  };

  describe("switched on, after the migration", () => {
    beforeAll(() => {
      process.env.ASK_SQL_ENABLED = "true";
    });

    test("web Ask: no other shop's value, no database error text, anywhere", async () => {
      reset();
      const { streamed, conversation } = await askOnTheWeb();
      const out = { ...(await exposed(conversation)), streamed };
      // The tool did run: shop A's own customer came back.
      expect(out.prompts).toContain("A-CUSTOMER");
      expect(out.saved).toContain("A-CUSTOMER");
      for (const [where, text] of Object.entries(out)) {
        expect({ where, leaked: text.includes(MARK) }).toEqual({
          where,
          leaked: false,
        });
        expect({ where, raw: rawAround(text) }).toEqual({ where, raw: null });
      }
      // Failures are logged with a reference, never the SQL or the value.
      expect(out.logs).toMatch(/"ref":"[0-9a-f]{8}"/);
      expect(out.logs).not.toContain("A-CUSTOMER");
      expect(out.logs).not.toContain("::int");
    });

    test("email Ask: no other shop's value, no database error text, anywhere", async () => {
      reset();
      await askByEmail();
      const out = await exposed();
      expect(seen.emails).toHaveLength(1);
      expect(out.emails).toContain("A-CUSTOMER");
      for (const [where, text] of Object.entries(out)) {
        expect({ where, leaked: text.includes(MARK) }).toEqual({
          where,
          leaked: false,
        });
        expect({ where, raw: rawAround(text) }).toEqual({ where, raw: null });
      }
    });
  });

  describe("switched off (the default)", () => {
    beforeAll(() => {
      Reflect.deleteProperty(process.env, "ASK_SQL_ENABLED");
    });

    test("web and email Ask answer without running any SQL", async () => {
      const { ASK_SQL_OFF } = await import("@repo/database/reader");
      reset();
      const { streamed } = await askOnTheWeb();
      await askByEmail();
      const out = await exposed();
      expect(out.prompts).toContain(ASK_SQL_OFF);
      expect(out.prompts).not.toContain("A-CUSTOMER");
      expect(streamed).not.toContain("A-CUSTOMER");
      expect(out.emails).not.toContain("A-CUSTOMER");
      expect(seen.emails).toHaveLength(1);
      expect(`${out.prompts}${streamed}${out.emails}`).not.toContain(MARK);
    });
  });
});
