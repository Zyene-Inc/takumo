// @vitest-environment node
// Gate G3 (independent review b): AI retrieval and derived data, with
// restricted access on. Each test failed while the leak it describes existed
// (G3-B, G3-C, G3-D).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SKIP_ENV_VALIDATION = "true";

vi.mock("server-only", () => ({}));
vi.mock("../../../packages/database/node_modules/server-only", () => ({}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../lib/ai-usage", () => ({
  recordUsage: vi.fn(),
  recordFailedUsage: vi.fn(),
  budgetProblem: vi.fn(async () => null),
}));

const members = new Map<string, string>();
vi.mock("@repo/auth/server", () => ({
  auth: vi.fn(),
  shopRole: async (userId: string, orgId: string) =>
    members.get(`${orgId}:${userId}`) ?? null,
  listShopMembers: async (orgId: string) =>
    [...members]
      .filter(([key]) => key.startsWith(`${orgId}:`))
      .map(([key, role]) => {
        const userId = key.slice(orgId.length + 1);
        return { id: userId, userId, role, email: "", name: userId };
      }),
}));
vi.mock("../lib/library/stage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confidentialEnabled: async () => true,
}));

// What the (mocked) note reader "hears" in a text message.
const heard: { facts: unknown[] } = { facts: [] };
vi.mock("@repo/ai", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  embed: async () => ({ embedding: [] }),
  generateText: async () => ({
    output: { facts: heard.facts },
    usage: {},
    finalStep: { response: { modelId: "mock" } },
  }),
}));
vi.mock("@repo/ai/lib/models", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  canEmbed: false,
}));

type Db = typeof import("@repo/database");
type Viewer = import("../lib/library/viewer").Viewer;
const id = () => randomUUID();
const EDITOR = 31;
const SECRET = "zebrasalary";

describe.skipIf(!TEST_DATABASE_URL)(
  "G3b: AI retrieval and derived data",
  () => {
    const A = `org_g3b_${id().slice(0, 8)}`;
    let database: Db["database"];
    let viewers: typeof import("../lib/library/viewer");
    let aiAccess: typeof import("../lib/library/ai-access");
    let tools: typeof import("../lib/agent/tools");
    let redact: typeof import("../lib/agent/redact");
    let provenance: typeof import("../lib/library/provenance");
    let visibility: typeof import("../lib/facts/visibility");
    const dept = { hr: id(), fin: id() };
    const folder = { general: id(), hr: id(), fin: id() };
    const doc = { pub: "", hr: "", fin: "" };
    let partId = "";
    let customerId = "";
    let number = 500;

    const as = async (userId: string): Promise<Viewer> => {
      const v = await viewers.viewerForMember(A, userId);
      if (!v) {
        throw new Error(`${userId} isn't a member`);
      }
      return v;
    };

    const addDoc = async (name: string, folderId: string, body: string) => {
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
          name: `${name}.txt`,
          status: "ready",
          stage: "done",
          activatedAt: new Date(),
        },
      });
      await database.source.update({
        where: { id: sourceId },
        data: { currentVersionId: versionId, versionSeq: 1 },
      });
      await database.docChunk.create({
        data: {
          orgId: A,
          sourceId,
          versionId,
          ordinal: 1,
          content: body,
          page: 1,
          meta: {},
        },
      });
      return sourceId;
    };

    const docFact = async (
      sourceId: string,
      data: {
        subjectType: "part" | "customer";
        subjectId: string;
        subjectLabel: string;
        attribute: string;
        value: string | number;
        quote: string;
        status?: "pending" | "approved";
      }
    ) => {
      number =
        Math.max(
          number,
          (
            await database.fact.aggregate({
              where: { orgId: A },
              _max: { number: true },
            })
          )._max.number ?? 0
        ) + 1;
      return database.fact.create({
        data: {
          orgId: A,
          number,
          subjectType: data.subjectType,
          subjectId: data.subjectId,
          subjectLabel: data.subjectLabel,
          attribute: data.attribute,
          value: data.value,
          evidence: `"${data.quote}" (a document)`,
          source: "document",
          status: data.status ?? "pending",
          provenance: "documents",
          sources: { create: [{ orgId: A, sourceId, quote: data.quote }] },
        },
      });
    };

    const run = async (
      viewer: Viewer,
      name: "get_record" | "propose_fact",
      input: Record<string, unknown>
    ) => {
      const all = tools.createTools(tools.agentContext(viewer, "2026-11-08"));
      const execute = all[name].execute as unknown as (
        i: unknown,
        o: unknown
      ) => Promise<unknown>;
      return execute(input, { toolCallId: "t", messages: [] });
    };

    /** Save an answer exactly as /api/ask's onEnd does. */
    const saveAnswer = async (
      conversationId: string,
      text: string,
      used: { tool: string; input: unknown; output: unknown }[]
    ) => {
      const worked = await provenance.answerProvenance(A, conversationId, used);
      const messageId = id();
      await database.$transaction(async (tx) => {
        const found = await provenance.settleSources(tx, A, worked);
        await tx.message.create({
          data: {
            id: messageId,
            conversationId,
            role: "assistant",
            content: text,
            parts: [{ type: "text", text }],
            provenance: found.provenance,
          },
        });
        await provenance.recordAnswerSources(
          tx,
          A,
          conversationId,
          messageId,
          found
        );
        await provenance.linkProposedFacts(tx, A, used, found);
      });
      return worked;
    };

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      ({ database } = await import("@repo/database"));
      viewers = await import("../lib/library/viewer");
      aiAccess = await import("../lib/library/ai-access");
      tools = await import("../lib/agent/tools");
      redact = await import("../lib/agent/redact");
      provenance = await import("../lib/library/provenance");
      visibility = await import("../lib/facts/visibility");
      for (const [user, role] of [
        ["user_owner", "admin"],
        ["user_hr", "member"],
        ["user_fin", "member"],
        ["user_op", "operator"],
      ]) {
        members.set(`${A}:${user}`, role);
      }
      await database.org.create({
        data: {
          id: A,
          name: A,
          ownerUserId: "user_owner",
          libraryStage: "confidential",
        },
      });
      await database.department.createMany({
        data: [
          { id: dept.hr, orgId: A, name: "Human Resources" },
          { id: dept.fin, orgId: A, name: "Finance" },
        ],
      });
      await database.departmentMember.createMany({
        data: [
          { orgId: A, departmentId: dept.hr, userId: "user_hr" },
          { orgId: A, departmentId: dept.fin, userId: "user_fin" },
        ],
      });
      await database.folder.createMany({
        data: [
          { id: folder.general, orgId: A, name: "General" },
          {
            id: folder.hr,
            orgId: A,
            name: "People",
            confidential: true,
            inheritAccess: false,
          },
          {
            id: folder.fin,
            orgId: A,
            name: "Money",
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
            capabilities: EDITOR,
          },
          {
            orgId: A,
            folderId: folder.fin,
            principalType: "department",
            principalId: dept.fin,
            capabilities: EDITOR,
          },
        ],
      });
      doc.pub = await addDoc("Deburring SOP", folder.general, "Deburr edges.");
      doc.hr = await addDoc(
        "Payroll 2026",
        folder.hr,
        `Operator on P-G3B earns ${SECRET} $95,000.`
      );
      doc.fin = await addDoc(
        "Customer terms",
        folder.fin,
        "Acme G3B gets 87 day payment terms."
      );
      partId = (
        await database.part.create({ data: { orgId: A, partNo: "P-G3B" } })
      ).id;
      customerId = (
        await database.customer.create({ data: { orgId: A, name: "Acme G3B" } })
      ).id;
    });

    afterAll(async () => {
      await database.org.deleteMany({ where: { id: A } });
    });

    describe("F1: a published fact's restricted quote escapes provenance", () => {
      test("F1a: an answer quoting it isn't hidden once the asker loses access", async () => {
        const owner = await as("user_owner");
        const fact = await docFact(doc.hr, {
          subjectType: "part",
          subjectId: partId,
          subjectLabel: "P-G3B rev A",
          attribute: "note",
          value: "Pay grade matters for this part",
          quote: `Operator on P-G3B earns ${SECRET} $95,000.`,
          status: "approved",
        });
        // Published on purpose: the fact's value is company knowledge; its
        // quote stays restricted to people who may open Payroll.
        expect(await visibility.publishFact(owner, fact.id)).toMatchObject({
          ok: true,
        });
        const company = await aiAccess.factAccess(viewers.systemViewer(A));
        expect(company.get(fact.id)).toEqual({ evidence: false });

        // HR asks; get_record hands the model the restricted quote.
        const hr = await as("user_hr");
        const input = { type: "part", key: "P-G3B" };
        const output = await run(hr, "get_record", input);
        expect(JSON.stringify(output)).toContain(SECRET);

        const conversation = await database.conversation.create({
          data: { orgId: A, userId: "user_hr", title: "P-G3B" },
        });
        await database.message.create({
          data: {
            conversationId: conversation.id,
            role: "user",
            content: "Tell me about P-G3B",
            parts: [{ type: "text", text: "Tell me about P-G3B" }],
            provenance: "recorded",
          },
        });
        const worked = await saveAnswer(
          conversation.id,
          `The record quotes: ${SECRET} $95,000.`,
          [{ tool: "get_record", input, output }]
        );
        // The answer repeats words from Payroll, so it should be tied to it.
        const linked = worked.documentIds.includes(doc.hr);

        // HR moves to another job: Payroll is out of reach now.
        await database.departmentMember.deleteMany({
          where: { orgId: A, userId: "user_hr", departmentId: dept.hr },
        });
        const { loadMessages } = await import("../lib/agent/conversations");
        const shown = JSON.stringify(
          await redact.redactHistory(
            await as("user_hr"),
            conversation.id,
            await loadMessages(conversation.id)
          )
        );
        await database.departmentMember.create({
          data: { orgId: A, departmentId: dept.hr, userId: "user_hr" },
        });
        expect({ linked, stillShown: shown.includes(SECRET) }).toEqual({
          linked: true,
          stillShown: false,
        });
      });

      test("F1b: a fact proposed in that answer doesn't carry the quote to everyone", async () => {
        // Same setup: HR reads the published fact (quote included), and the
        // model records a note in the same answer, quoting what it read (a
        // prompt-injected or simply over-helpful model; the user only asked
        // to "note that").
        const hr = await as("user_hr");
        const input = { type: "part", key: "P-G3B" };
        const output = await run(hr, "get_record", input);
        expect(JSON.stringify(output)).toContain(SECRET);
        const proposeInput = {
          subject_type: "part",
          part_no: "P-G3B",
          attribute: "note",
          value: "Check pay grade before staffing",
          evidence: `Operator on P-G3B earns ${SECRET} $95,000.`,
        };
        const proposed = (await run(hr, "propose_fact", proposeInput)) as {
          fact?: string;
        };
        expect(proposed.fact).toBeTruthy();
        const conversation = await database.conversation.create({
          data: { orgId: A, userId: "user_hr", title: "Note it" },
        });
        await saveAnswer(conversation.id, "Noted.", [
          { tool: "get_record", input, output },
          { tool: "propose_fact", input: proposeInput, output: proposed },
        ]);
        const made = await database.fact.findFirstOrThrow({
          where: { orgId: A, number: Number(proposed.fact?.slice(2)) },
        });
        // The operator (no access to Payroll) now sees the quote, in the facts
        // list and through get_record.
        const op = await as("user_op");
        const opAccess = await aiAccess.factAccess(op);
        const opRecord = JSON.stringify(
          await run(op, "get_record", { type: "part", key: "P-G3B" })
        );
        // The answer was shown the HR quote, so it is linked to the HR
        // document (G3-B) and the fact it made gets that document as its
        // source: seen only by those who may use it.
        expect(made.provenance).toBe("documents");
        expect({
          operatorSeesFact: opAccess.has(made.id),
          operatorSeesQuote: opRecord.includes(SECRET),
        }).toEqual({ operatorSeesFact: false, operatorSeesQuote: false });
      });
    });

    describe("F2: a text-message note confirms a hidden fact's value", () => {
      test("F2: a phone-only operator's guess joins the hidden Finance fact and is told its number", async () => {
        const hidden = await docFact(doc.fin, {
          subjectType: "customer",
          subjectId: customerId,
          subjectLabel: "Acme G3B",
          attribute: "paymentTermDays",
          value: 87,
          quote: "Acme G3B gets 87 day payment terms.",
        });
        const label = `F-${hidden.number}`;
        // Nobody outside Finance may see it.
        expect(
          (await aiAccess.factAccess(await as("user_op"))).has(hidden.id)
        ).toBe(false);
        const { saveNote } = await import("../lib/facts/notes");
        const guess = async (days: number) => {
          heard.facts = [
            {
              subjectType: "customer",
              partNo: null,
              rev: null,
              seq: null,
              name: "Acme G3B",
              attribute: "paymentTermDays",
              value: days,
              quote: `Acme pays in ${days} days`,
            },
          ];
          // As lib/phone/inbound.ts does for a roster phone without a login.
          return (
            await saveNote(A, "phone:roster-1", {
              kind: "typed",
              text: `Acme pays in ${days} days`,
              source: "note",
              channel: "sms",
            })
          ).proposed;
        };
        const wrong = await guess(60);
        const right = await guess(87);
        // The reply (replyText) lists these labels: a guess that matches the
        // hidden value must not come back with the hidden fact's number.
        expect(wrong).not.toContain(label);
        expect(right).not.toContain(label);
      });
    });

    describe("F3: lowering a folder's AI setting leaves AI-derived record links", () => {
      test("F3: passages keep meta.mentions (from the AI's understanding) after AI is turned off", async () => {
        const aiFolder = id();
        await database.folder.create({
          data: { id: aiFolder, orgId: A, name: "AI folder", aiMode: "full" },
        });
        await database.accessGrant.create({
          data: {
            orgId: A,
            folderId: aiFolder,
            principalType: "everyone",
            capabilities: 7,
          },
        });
        const src = await addDoc("Mentions doc", aiFolder, "Run P-G3B slowly.");
        // As the chunk stage writes it in "full": context and mentions.
        await database.docChunk.updateMany({
          where: { sourceId: src },
          data: {
            meta: { context: "AI context", mentions: [`part:${partId}`] },
          },
        });
        const { setFolderAiMode } = await import("../lib/library/ai-settings");
        expect(
          await setFolderAiMode(await as("user_owner"), aiFolder, "off")
        ).toEqual({ ok: true });
        const [chunk] = await database.docChunk.findMany({
          where: { sourceId: src },
          select: { meta: true },
        });
        const meta = chunk?.meta as Record<string, unknown>;
        expect(meta.context).toBeUndefined();
        expect(meta.mentions ?? []).toEqual([]);
      });
    });

    test("an answer that proposes a fact is recorded, not hidden from its own asker", async () => {
      const msg = await database.message.findFirst({
        where: {
          conversation: { orgId: A, title: "Note it" },
          role: "assistant",
        },
        select: { provenance: true },
      });
      // The fact it made came from this conversation: the answer is traced,
      // and the fact gets the conversation's documents (linkProposedFacts).
      expect(msg?.provenance).toBe("recorded");
    });
  }
);
