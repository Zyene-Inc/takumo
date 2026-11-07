// @vitest-environment node
// Where facts and answers came from, against a real database (Knowledge Hub
// phase 2): document facts are linked to every document (and version) that
// states them, answers record the documents they drew on, directly and
// through earlier answers in the conversation, and anything that can't be
// attributed is marked as such rather than assumed safe. Nothing is hidden
// yet (phase 4). Runs only with TEST_DATABASE_URL.
import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

const h = await vi.hoisted(
  async () => await import("./fixtures/library-harness")
);

vi.mock("server-only", () => ({}));
vi.mock("../../../packages/database/node_modules/server-only", () => ({}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/auth/server", () => ({
  auth: async () => h.state.session,
  shopRole: async () => null,
}));
vi.mock("../lib/library/storage", async (original) => ({
  ...(await original<object>()),
  objectStore: () => h.state.store,
}));
vi.mock("../lib/knowledge/read", () => ({ readDocument: h.scriptedRead }));
vi.mock("../lib/knowledge/understand", async (original) => ({
  ...(await original<object>()),
  loadCatalog: async () => ({}),
  understandDocument: async (_org: string, name: string) => ({
    card: {
      docType: "sop",
      title: name,
      revision: null,
      summary: `About ${name}.`,
      mentions: [],
    },
    linked: [],
    unmatched: [],
  }),
  contextualize: async (_org: string, _doc: unknown, chunks: string[]) =>
    chunks.map(() => ""),
}));
vi.mock("@repo/ai", async (original) => ({
  ...(await original<object>()),
  embedMany: (args: { values: string[] }) => h.scriptedEmbedMany(args),
  embed: () => h.scriptedEmbed(),
}));
vi.mock("@repo/ai/lib/models", async (original) => ({
  ...(await original<object>()),
  canEmbed: true,
  embeddingOptions: () => ({}),
}));
vi.mock("../lib/facts/notes", () => ({
  shopContext: async () => "",
  extractFacts: async () => h.state.facts,
}));
vi.mock("../lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../lib/billing", () => ({ featureProblem: async () => null }));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

type Db = typeof import("@repo/database");
type ToolUse = import("../lib/library/provenance").ToolUse;

describe.skipIf(!TEST_DATABASE_URL)("provenance (database)", () => {
  let database: Db["database"];
  let ingest: typeof import("../lib/knowledge/ingest");
  let facts: typeof import("../lib/facts/facts");
  let provenance: typeof import("../lib/library/provenance");
  let citations: typeof import("../lib/agent/citations");
  let orgId = "";
  let partId = "";

  const FACT = {
    subjectType: "part",
    partNo: "P-1001",
    attribute: "note",
    value: "Machine XYZ runs at $110 an hour",
    quote: "XYZ: $110/hr",
  };

  const add = async (name: string, body: string) =>
    (
      await ingest.ingestDocument(
        orgId,
        "user_planner",
        { name, bytes: h.text(body) },
        () => undefined,
        { via: "upload" }
      )
    ).sourceId;

  /** What search_documents returns for a hit in this document. */
  const searched = (sourceId: string, name: string): ToolUse => ({
    tool: "search_documents",
    input: { query: "rate" },
    output: { sources: [citations.cite.doc(name, 1, sourceId, "rate")] },
  });

  /** Save an answer as the ask route does, with its documents. */
  const answer = async (conversationId: string, tools: ToolUse[]) => {
    const worked = await provenance.answerProvenance(
      orgId,
      conversationId,
      tools
    );
    const id = randomUUID();
    const found = await database.$transaction(async (tx) => {
      const settled = await provenance.settleSources(tx, orgId, worked);
      await tx.message.create({
        data: {
          id,
          conversationId,
          role: "assistant",
          content: "An answer.",
          provenance: settled.provenance,
          ...(settled.gone ? provenance.removedAnswer() : {}),
        },
      });
      await provenance.recordAnswerSources(
        tx,
        orgId,
        conversationId,
        id,
        settled
      );
      await provenance.linkProposedFacts(tx, orgId, tools, settled);
      return settled;
    });
    return { id, found };
  };

  const sourcesOf = (messageId: string) =>
    database.messageSource.findMany({
      where: { messageId },
      orderBy: { sourceId: "asc" },
      select: { sourceId: true, versionId: true, direct: true, via: true },
    });

  const conversation = async () =>
    (
      await database.conversation.create({
        data: { orgId, userId: "user_planner" },
      })
    ).id;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SKIP_ENV_VALIDATION = "true";
    ({ database } = await import("@repo/database"));
    ingest = await import("../lib/knowledge/ingest");
    facts = await import("../lib/facts/facts");
    provenance = await import("../lib/library/provenance");
    citations = await import("../lib/agent/citations");
  });

  beforeEach(async () => {
    h.resetState();
    orgId = `org_prov_${randomUUID().slice(0, 8)}`;
    await database.org.create({ data: { id: orgId, name: "Provenance" } });
    partId = (await database.part.create({ data: { orgId, partNo: "P-1001" } }))
      .id;
    h.state.session.orgId = orgId;
  });

  afterAll(async () => {
    await database?.org.deleteMany({
      where: { id: { startsWith: "org_prov_" } },
    });
  });

  describe("facts", () => {
    test("a fact read from a document is linked to it and the version it came from", async () => {
      h.state.facts = [FACT];
      const sourceId = await add("Machine rates.txt", "XYZ: $110/hr");
      const fact = await database.fact.findFirstOrThrow({
        where: { orgId },
        include: { sources: true },
      });
      const current = await database.source.findUniqueOrThrow({
        where: { id: sourceId },
      });
      expect(fact).toMatchObject({
        provenance: "documents",
        source: "document",
        statedBy: "user_planner",
        status: "pending",
      });
      expect(fact.sources).toEqual([
        expect.objectContaining({
          sourceId,
          versionId: current.currentVersionId,
          quote: "XYZ: $110/hr",
        }),
      ]);
    });

    test("the same fact in a second document adds a source, not a second fact", async () => {
      h.state.facts = [FACT];
      const rates = await add("Machine rates.txt", "XYZ: $110/hr");
      const pricing = await add("Pricing sheet.txt", "XYZ: $110/hr");
      expect(await database.fact.count({ where: { orgId } })).toBe(1);
      const links = await database.factSource.findMany({
        where: { orgId },
        select: { sourceId: true },
      });
      expect(links.map((l) => l.sourceId).sort()).toEqual(
        [rates, pricing].sort()
      );
    });

    test("facts people state have no document; chat facts and older facts stay unknown", async () => {
      const subject = { type: "part" as const, id: partId, label: "P-1001" };
      const said = await facts.proposeFact(orgId, {
        subject,
        attribute: "note",
        value: "Spoken on the floor",
        evidence: null,
        source: "voice",
        statedBy: "user_op",
      });
      const chatted = await facts.proposeFact(orgId, {
        subject,
        attribute: "note",
        value: "Said in chat",
        evidence: null,
        source: "chat",
        statedBy: "user_op",
      });
      const older = await database.fact.create({
        data: {
          orgId,
          number: 99,
          subjectType: "part",
          subjectId: partId,
          subjectLabel: "P-1001",
          attribute: "note",
          value: "From before",
          source: "document",
          evidence: `"x" (Some SOP)`,
        },
      });
      const provenanceOf = async (id: string) =>
        (await database.fact.findUniqueOrThrow({ where: { id } })).provenance;
      expect(said.ok && (await provenanceOf(said.fact.id))).toBe("none");
      expect(chatted.ok && (await provenanceOf(chatted.fact.id))).toBe(
        "unknown"
      );
      expect(await provenanceOf(older.id)).toBe("unknown");
      expect(await database.factSource.count({ where: { orgId } })).toBe(0);
    });
  });

  describe("answers", () => {
    test("an answer records the documents its search returned, with their version", async () => {
      const sourceId = await add("Coolant.txt", "Coolant ratio 8%.");
      const current = await database.source.findUniqueOrThrow({
        where: { id: sourceId },
      });
      const cid = await conversation();
      const { id, found } = await answer(cid, [searched(sourceId, "Coolant")]);
      expect(found.provenance).toBe("recorded");
      expect(await sourcesOf(id)).toEqual([
        {
          sourceId,
          versionId: current.currentVersionId,
          direct: true,
          via: "document",
        },
      ]);
    });

    test("a later answer carries the documents of earlier ones, even without searching", async () => {
      const coolant = await add("Coolant.txt", "Coolant ratio 8%.");
      const spindle = await add("Spindle.txt", "Warm up ten minutes.");
      const cid = await conversation();
      await answer(cid, [searched(coolant, "Coolant")]);
      const second = await answer(cid, [searched(spindle, "Spindle")]);
      const third = await answer(cid, []);
      expect(second.found.provenance).toBe("recorded");
      expect(
        (await sourcesOf(second.id)).map((s) => [s.sourceId, s.direct])
      ).toEqual(
        expect.arrayContaining([
          [coolant, false],
          [spindle, true],
        ])
      );
      const inherited = await sourcesOf(third.id);
      expect(inherited).toHaveLength(2);
      expect(inherited.every((s) => !s.direct && s.via === "inherited")).toBe(
        true
      );
    });

    test("facts an answer read bring their documents with them", async () => {
      h.state.facts = [FACT];
      const sourceId = await add("Machine rates.txt", "XYZ: $110/hr");
      const fact = await database.fact.findFirstOrThrow({ where: { orgId } });
      const cid = await conversation();
      const { id, found } = await answer(cid, [
        {
          tool: "get_record",
          input: { type: "part", key: "P-1001" },
          output: { sources: [citations.cite.fact(`F-${fact.number}`, "x")] },
        },
      ]);
      expect(found.provenance).toBe("recorded");
      expect(await sourcesOf(id)).toEqual([
        expect.objectContaining({ sourceId, direct: true, via: "fact" }),
      ]);
    });

    test("what can't be attributed makes an answer partial, never assumed safe", async () => {
      // An answer from before provenance was recorded, earlier in the chat.
      const legacyChat = await conversation();
      await database.message.create({
        data: {
          conversationId: legacyChat,
          role: "assistant",
          content: "Old answer.",
        },
      });
      expect((await answer(legacyChat, [])).found.provenance).toBe("partial");

      // Facts read in bulk by a query.
      const bulk = await answer(await conversation(), [
        {
          tool: "query_data",
          input: { sql: "select * from facts" },
          output: { rows: [], sources: [] },
        },
      ]);
      expect(bulk.found.provenance).toBe("partial");

      // A fact whose origin was never recorded.
      const unknown = await database.fact.create({
        data: {
          orgId,
          number: 50,
          subjectType: "shop",
          subjectId: orgId,
          subjectLabel: "Shop",
          attribute: "note",
          value: "x",
        },
      });
      const viaFact = await answer(await conversation(), [
        {
          tool: "get_record",
          input: {},
          output: {
            sources: [citations.cite.fact(`F-${unknown.number}`, "x")],
          },
        },
      ]);
      expect(viaFact.found.provenance).toBe("partial");
    });

    test("a fact proposed in chat after reading documents is linked to them", async () => {
      const sourceId = await add("Setup sheet.txt", "Setup 30 minutes.");
      const cid = await conversation();
      const proposed = await facts.proposeFact(orgId, {
        subject: { type: "part", id: partId, label: "P-1001" },
        attribute: "note",
        value: "Setup is 30 minutes",
        evidence: "the setup sheet says so",
        source: "chat",
        statedBy: "user_planner",
      });
      if (!proposed.ok) {
        throw new Error(proposed.error);
      }
      await answer(cid, [
        searched(sourceId, "Setup sheet"),
        {
          tool: "propose_fact",
          input: {},
          output: { fact: proposed.fact.label, sources: [] },
        },
      ]);
      const fact = await database.fact.findUniqueOrThrow({
        where: { id: proposed.fact.id },
        include: { sources: true },
      });
      expect(fact.provenance).toBe("documents");
      expect(fact.sources.map((s) => s.sourceId)).toEqual([sourceId]);
    });

    test("another shop's document named in a tool result isn't recorded, and the answer isn't trusted", async () => {
      const otherOrg = `org_prov_other_${randomUUID().slice(0, 8)}`;
      await database.org.create({ data: { id: otherOrg, name: "Other" } });
      const theirs = await database.source.create({
        data: {
          orgId: otherOrg,
          name: "Theirs",
          type: "upload",
          profile: "document",
        },
      });
      const { id, found } = await answer(await conversation(), [
        searched(theirs.id, "Theirs"),
      ]);
      expect(await sourcesOf(id)).toEqual([]);
      expect(found).toMatchObject({ gone: true, provenance: "partial" });
      expect(
        (await database.message.findUniqueOrThrow({ where: { id } })).provenance
      ).toBe("removed");
      // And the database refuses such a link outright.
      const cid = await conversation();
      const msg = await database.message.create({
        data: { conversationId: cid, role: "assistant", content: "x" },
      });
      await expect(
        database.messageSource.create({
          data: {
            orgId: otherOrg,
            conversationId: cid,
            messageId: msg.id,
            sourceId: theirs.id,
            direct: true,
            via: "document",
          },
        })
      ).rejects.toThrow();
    });
  });
});
