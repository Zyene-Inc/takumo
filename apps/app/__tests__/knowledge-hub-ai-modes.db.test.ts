// @vitest-environment node
// Folder AI settings (Knowledge Hub phase 4) through the real processing
// pipeline, with every outside AI call counted: "off" and "search" send
// nothing (no recognising of scans, understanding, context sentences,
// vectors or facts), "full" runs everything, lowering a setting removes what
// AI derived, and a run already going when it's lowered can't bring any of
// it back. Text is read by the real reader (plain text and images); only the
// AI services are stand-ins. Runs only with TEST_DATABASE_URL.
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

const calls = {
  generateText: 0,
  embedMany: 0,
  embed: 0,
  understand: 0,
  contextualize: 0,
  facts: 0,
};
/** Runs inside a stage, to change the setting while a document is being read. */
const during = {
  understand: null as null | (() => Promise<void>),
  contextualize: null as null | (() => Promise<void>),
};

vi.mock("server-only", () => ({}));
vi.mock("../../../packages/database/node_modules/server-only", () => ({}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const members = new Map<string, string>();
vi.mock("@repo/auth/server", () => ({
  auth: async () => h.state.session,
  shopRole: async (userId: string, orgId: string) =>
    members.get(`${orgId}:${userId}`) ?? null,
  listShopMembers: async () => [],
}));
vi.mock("../lib/library/stage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confidentialEnabled: async () => true,
}));
vi.mock("../lib/library/storage", async (original) => ({
  ...(await original<object>()),
  objectStore: () => h.state.store,
}));
vi.mock("../lib/knowledge/understand", async (original) => ({
  ...(await original<object>()),
  loadCatalog: async () => ({}),
  understandDocument: async (_org: string, name: string) => {
    calls.understand += 1;
    await during.understand?.();
    return {
      card: {
        docType: "sop",
        title: name,
        revision: "B",
        summary: `AI summary of ${name}.`,
        mentions: [],
      },
      linked: [],
      unmatched: [],
    };
  },
  contextualize: async (_org: string, _doc: unknown, chunks: string[]) => {
    calls.contextualize += 1;
    await during.contextualize?.();
    return chunks.map(() => "AI context sentence");
  },
}));
vi.mock("@repo/ai", async (original) => ({
  ...(await original<object>()),
  // Recognising scans and photos calls this: it must never run when off.
  generateText: async () => {
    calls.generateText += 1;
    throw new Error("An AI service was called");
  },
  embedMany: (args: { values: string[] }) => {
    calls.embedMany += 1;
    return h.scriptedEmbedMany(args);
  },
  embed: () => {
    calls.embed += 1;
    return h.scriptedEmbed();
  },
}));
vi.mock("@repo/ai/lib/models", async (original) => ({
  ...(await original<object>()),
  canEmbed: true,
  embeddingOptions: () => ({}),
}));
vi.mock("../lib/facts/notes", () => ({
  shopContext: async () => "",
  extractFacts: async () => {
    calls.facts += 1;
    return h.state.facts;
  },
}));
vi.mock("../lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../lib/billing", () => ({ featureProblem: async () => null }));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
type Db = typeof import("@repo/database");

describe.skipIf(!TEST_DATABASE_URL)("folder AI settings (database)", () => {
  const orgId = `org_ai_${randomUUID().slice(0, 8)}`;
  let database: Db["database"];
  let versions: typeof import("../lib/library/versions");
  let processing: typeof import("../lib/library/process");
  let documents: typeof import("../lib/knowledge/documents");
  let settings: typeof import("../lib/library/ai-settings");
  let viewers: typeof import("../lib/library/viewer");
  let stages: typeof import("../lib/library/stages");
  const folder = {
    off: randomUUID(),
    search: randomUUID(),
    full: randomUUID(),
  };

  const owner = async () => {
    const viewer = await viewers.viewerForMember(orgId, "user_owner");
    if (!viewer) {
      throw new Error("no owner");
    }
    return viewer;
  };

  const readInto = async (
    folderId: string,
    name: string,
    body: string | Uint8Array
  ) => {
    const made = await versions.createDocument(
      orgId,
      "user_owner",
      {
        name,
        bytes: typeof body === "string" ? h.text(body) : body,
        mimeType: name.endsWith(".png") ? "image/png" : "text/plain",
      },
      "upload",
      folderId
    );
    const run = await processing.processVersion(made.versionId);
    return { ...made, run };
  };

  const passages = (sourceId: string) =>
    database.$queryRawUnsafe<
      { context: string | null; embedded: boolean; kind: string | null }[]
    >(
      `select meta ->> 'context' as context, embedding is not null as embedded,
              meta ->> 'kind' as kind
       from "DocChunk" where "sourceId" = $1 order by ordinal`,
      sourceId
    );

  const noAiCalls = () =>
    expect(calls).toEqual({
      generateText: 0,
      embedMany: 0,
      embed: 0,
      understand: 0,
      contextualize: 0,
      facts: 0,
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SKIP_ENV_VALIDATION = "true";
    ({ database } = await import("@repo/database"));
    versions = await import("../lib/library/versions");
    processing = await import("../lib/library/process");
    documents = await import("../lib/knowledge/documents");
    settings = await import("../lib/library/ai-settings");
    viewers = await import("../lib/library/viewer");
    stages = await import("../lib/library/stages");
    members.set(`${orgId}:user_owner`, "admin");
    await database.org.create({
      data: {
        id: orgId,
        name: "AI settings",
        ownerUserId: "user_owner",
        libraryStage: "confidential",
      },
    });
    await database.part.create({ data: { orgId, partNo: "P-1001" } });
    await database.folder.createMany({
      data: [
        { id: folder.off, orgId, name: "HR", aiMode: "off" },
        { id: folder.search, orgId, name: "Policies", aiMode: "search" },
        { id: folder.full, orgId, name: "SOPs", aiMode: "full" },
      ],
    });
    await database.accessGrant.createMany({
      data: Object.values(folder).map((folderId) => ({
        orgId,
        folderId,
        principalType: "everyone",
        capabilities: 7,
      })),
    });
  });

  beforeEach(() => {
    h.resetState();
    for (const key of Object.keys(calls) as (keyof typeof calls)[]) {
      calls[key] = 0;
    }
    during.understand = null;
    during.contextualize = null;
    h.state.facts = [
      {
        subjectType: "part",
        partNo: "P-1001",
        attribute: "note",
        value: "Deburr after op 20",
        quote: "Deburr after op 20",
      },
    ];
  });

  afterAll(async () => {
    await database.org.deleteMany({ where: { id: orgId } });
  });

  test("off: nothing is sent anywhere; the library can still search it, Ask can't", async () => {
    const made = await readInto(
      folder.off,
      "Payroll.txt",
      "Payroll zebrapay 2026."
    );
    expect(made.run.result).toBe("done");
    noAiCalls();
    expect(await passages(made.sourceId)).toEqual(
      expect.arrayContaining([
        { context: null, embedded: false, kind: "card" },
        { context: null, embedded: false, kind: null },
      ])
    );
    const source = await database.source.findUniqueOrThrow({
      where: { id: made.sourceId },
    });
    expect(source.summary).not.toContain("AI summary");
    expect(await database.fact.count({ where: { orgId } })).toBe(0);
    const viewer = await owner();
    expect(
      (await documents.keywordPassages(viewer, "zebrapay")).map(
        (p) => p.sourceId
      )
    ).toEqual([made.sourceId]);
    expect(await documents.searchDocuments(viewer, "zebrapay")).toEqual([]);
    // Searching didn't even embed the question: no document allows vectors.
    expect(calls.embed).toBe(0);
  });

  test("off: a photo isn't read at all, and says why", async () => {
    const made = await readInto(
      folder.off,
      "Receipt.png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    expect(made.run).toMatchObject({
      result: "failed",
      error: stages.NO_TEXT_AI_OFF,
    });
    noAiCalls();
  });

  test("search: nothing is sent while reading; Ask finds it by keywords only", async () => {
    const made = await readInto(
      folder.search,
      "Policy.txt",
      "Leave policy otterleave."
    );
    expect(made.run.result).toBe("done");
    noAiCalls();
    const hits = await documents.searchDocuments(await owner(), "otterleave");
    expect(hits.map((h) => h.sourceId)).toEqual([made.sourceId]);
  });

  test("full: understood, given context, embedded and its facts proposed", async () => {
    const made = await readInto(
      folder.full,
      "Deburr.txt",
      "Deburr after op 20 lynxedge."
    );
    expect(made.run.result).toBe("done");
    expect(calls).toMatchObject({
      understand: 1,
      contextualize: 1,
      embedMany: 1,
      facts: 1,
      generateText: 0,
    });
    expect(await passages(made.sourceId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          context: "AI context sentence",
          embedded: true,
        }),
      ])
    );
    expect(
      await database.fact.count({ where: { orgId, status: "pending" } })
    ).toBe(1);
  });

  test("lowering full to off removes what AI derived, at once", async () => {
    const made = await readInto(
      folder.full,
      "Torque.txt",
      "Torque spec ibexbolt."
    );
    // The same fact found again: one pending fact, from both documents.
    expect(
      await database.factSource.count({
        where: { orgId, fact: { status: "pending" } },
      })
    ).toBe(2);
    const viewer = await owner();
    expect(await settings.setFolderAiMode(viewer, folder.full, "off")).toEqual({
      ok: true,
    });
    for (const p of await passages(made.sourceId)) {
      expect(p).toMatchObject({ context: null, embedded: false });
    }
    const card = await database.docChunk.findFirstOrThrow({
      where: { sourceId: made.sourceId, ordinal: 0 },
    });
    expect(card.meta).toMatchObject({ kind: "card", docType: "other" });
    expect(
      (
        await database.source.findUniqueOrThrow({
          where: { id: made.sourceId },
        })
      ).summary
    ).toBeNull();
    // Unreviewed facts read from those documents are gone.
    expect(
      await database.fact.count({ where: { orgId, status: "pending" } })
    ).toBe(0);
    expect(await documents.searchDocuments(viewer, "ibexbolt")).toEqual([]);
    expect(
      (await documents.keywordPassages(viewer, "ibexbolt")).length
    ).toBeGreaterThan(0);
    expect(
      await database.documentAuditLog.count({
        where: { orgId, action: "folder_ai_mode" },
      })
    ).toBe(1);
    await settings.setFolderAiMode(viewer, folder.full, "full");
  });

  test("a run already going when AI is turned off can't bring anything back", async () => {
    const viewer = await owner();
    // Turned off while the document is being understood.
    during.understand = async () => {
      await settings.setFolderAiMode(viewer, folder.full, "off");
    };
    const made = await readInto(
      folder.full,
      "Late.txt",
      "Late change cobrafix."
    );
    expect(made.run.result).toBe("done");
    expect(calls).toMatchObject({ contextualize: 0, embedMany: 0, facts: 0 });
    for (const p of await passages(made.sourceId)) {
      expect(p).toMatchObject({ context: null, embedded: false });
    }
    const card = await database.docChunk.findFirstOrThrow({
      where: { sourceId: made.sourceId, ordinal: 0 },
    });
    expect(card.meta).toMatchObject({ docType: "other" });
    await settings.setFolderAiMode(viewer, folder.full, "full");

    // Turned off after the context sentences came back, before they're saved:
    // only the locked re-check when writing stops them.
    during.understand = null;
    during.contextualize = async () => {
      await settings.setFolderAiMode(viewer, folder.full, "off");
    };
    const second = await readInto(
      folder.full,
      "Later.txt",
      "Later change gecko."
    );
    expect(second.run.result).toBe("done");
    expect(calls.contextualize).toBe(1);
    expect(calls.embedMany).toBe(0);
    for (const p of await passages(second.sourceId)) {
      expect(p).toMatchObject({ context: null, embedded: false });
    }
    expect(
      await database.fact.count({
        where: { orgId, sources: { some: { sourceId: second.sourceId } } },
      })
    ).toBe(0);
    await settings.setFolderAiMode(viewer, folder.full, "full");
  });

  test("turning AI on for a confidential folder asks first; only managers may change it", async () => {
    await database.folder.update({
      where: { id: folder.off },
      data: { confidential: true },
    });
    const viewer = await owner();
    expect(
      await settings.setFolderAiMode(viewer, folder.off, "full")
    ).toMatchObject({ ok: false, confirm: true });
    expect(
      await settings.setFolderAiMode(viewer, folder.off, "full", {
        confirmed: true,
      })
    ).toEqual({ ok: true });
    await settings.setFolderAiMode(viewer, folder.off, "off");
    members.set(`${orgId}:user_op`, "operator");
    const op = await viewers.viewerForMember(orgId, "user_op");
    expect(
      await settings.setFolderAiMode(
        op as NonNullable<typeof op>,
        folder.search,
        "full"
      )
    ).toMatchObject({ ok: false });
    expect(
      await settings.setFolderAiMode(viewer, folder.search, "sideways")
    ).toMatchObject({ ok: false });
  });

  test('a folder inside an "off" folder can\'t send more than it', async () => {
    const inner = await database.folder.create({
      data: { orgId, name: "Inner", parentId: folder.off, aiMode: "full" },
    });
    const made = await readInto(inner.id, "Inner.txt", "Inner text.");
    expect(made.run.result).toBe("done");
    noAiCalls();
  });
});
