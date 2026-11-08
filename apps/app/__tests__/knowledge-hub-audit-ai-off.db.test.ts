// @vitest-environment node
// Security audit regressions (Knowledge Hub phase 4), a folder's AI setting
// lowered, or a document trashed, while it is being read: M2 (context
// batches and fact windows kept going to the AI service after the setting
// was lowered), L1 (a fact proposed around the lowering survived it and came
// back when AI was raised), L10 (lowering left the AI summary and facts in
// the version's checkpoint) and L9 (a document in the Trash was still
// processed). These are the auditor's exploit steps through the real
// pipeline with real batching, asserting they now fail. Only the AI services
// are stand-ins, and every call to them is counted. Restricted access is
// switched off in code; these tests switch it on. Needs TEST_DATABASE_URL.
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

const MARKER = "CONFIDENTIAL_HR_TEST_92741";
const SLOW = 60_000;

/** Every outside AI call: which kind, and whether it came after the change. */
const sent: { kind: string; prompt: string; after: boolean }[] = [];
const flags = { changed: false };
/** Runs inside an AI call or step, to change things while a document is read. */
const during = {
  understand: null as null | (() => Promise<void>),
  context: null as null | (() => Promise<void>),
  facts: null as null | (() => Promise<void>),
  subject: null as null | (() => Promise<void>),
};

vi.mock("server-only", () => ({}));
vi.mock("../../../packages/database/node_modules/server-only", () => ({}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../lib/billing", () => ({ featureProblem: async () => null }));

// Active WorkOS memberships, "shop:user" → role (WorkOS is mocked).
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
  restrictedAccessReady: () => true,
}));
vi.mock("../lib/library/storage", async (original) => ({
  ...(await original<object>()),
  objectStore: () => h.state.store,
}));
vi.mock("../lib/ai-usage", () => ({
  recordUsage: async () => undefined,
  recordFailedUsage: async () => undefined,
  budgetProblem: async () => null,
}));
vi.mock("../lib/knowledge/understand", async (original) => ({
  ...(await original<object>()),
  loadCatalog: async () => ({ catalog: [], lists: "" }),
  understandDocument: async (_org: string, name: string, text: string) => {
    sent.push({ kind: "understand", prompt: text, after: flags.changed });
    await during.understand?.();
    return {
      card: {
        docType: "sop",
        title: name,
        revision: null,
        summary: `AI summary of ${name}.`,
        mentions: [],
      },
      linked: [],
      unmatched: [],
    };
  },
  // contextualize is the real one: it calls generateText below per batch.
}));
vi.mock("@repo/ai", async (original) => ({
  ...(await original<object>()),
  generateText: async (args: { prompt?: string }) => {
    const prompt = String(args.prompt ?? "");
    const context = prompt.includes("For each numbered passage");
    sent.push({
      kind: context ? "context" : "other",
      prompt,
      after: flags.changed,
    });
    if (!context) {
      throw new Error("An unexpected AI call was made");
    }
    await during.context?.();
    // A context sentence for every passage in the batch.
    const numbers = [...prompt.matchAll(/^\[(\d+)\]$/gm)].map((m) =>
      Number(m[1])
    );
    return {
      output: {
        contexts: numbers.map((n) => ({ n, context: "AI context sentence" })),
      },
      usage: {},
      finalStep: { response: { modelId: "stand-in" } },
    };
  },
  embedMany: (args: { values: string[] }) => {
    sent.push({
      kind: "embed",
      prompt: args.values.join("\n"),
      after: flags.changed,
    });
    return h.scriptedEmbedMany(args);
  },
  embed: () => h.scriptedEmbed(),
}));
vi.mock("@repo/ai/lib/models", async (original) => ({
  ...(await original<object>()),
  canEmbed: true,
  embeddingOptions: () => ({}),
}));
vi.mock("../lib/facts/notes", () => ({
  shopContext: async () => "",
  extractFacts: async (_org: string, text: string) => {
    sent.push({ kind: "facts", prompt: text, after: flags.changed });
    await during.facts?.();
    return h.state.facts;
  },
}));
/** Facts the pipeline proposed (created or added to), by value. */
const proposed: string[] = [];
vi.mock("../lib/facts/facts", async (original) => {
  const real = await original<typeof import("../lib/facts/facts")>();
  return {
    ...real,
    proposeFact: async (...args: Parameters<typeof real.proposeFact>) => {
      const made = await real.proposeFact(...args);
      if (made.ok) {
        proposed.push(String(args[1].value));
      }
      return made;
    },
  };
});
vi.mock("../lib/facts/subjects", async (original) => {
  const real = await original<typeof import("../lib/facts/subjects")>();
  return {
    ...real,
    findSubject: async (...args: Parameters<typeof real.findSubject>) => {
      await during.subject?.();
      return real.findSubject(...args);
    },
  };
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
type Db = typeof import("@repo/database");

const AI_KEYS = ["understanding", "facts", "factsDone", "tally"];

describe.skipIf(!TEST_DATABASE_URL)(
  "security audit: AI lowered or document trashed mid-run (M2, L1, L10, L9)",
  () => {
    const orgId = `org_audit_aioff_${randomUUID().slice(0, 8)}`;
    let database: Db["database"];
    let versions: typeof import("../lib/library/versions");
    let processing: typeof import("../lib/library/process");
    let settings: typeof import("../lib/library/ai-settings");
    let viewers: typeof import("../lib/library/viewer");
    let aiAccess: typeof import("../lib/library/ai-access");
    let lease: typeof import("../lib/library/lease");
    let sweep: typeof import("../lib/library/sweep");
    let lifecycle: typeof import("../lib/library/lifecycle");

    const owner = async () => {
      const viewer = await viewers.viewerForMember(orgId, "user_owner");
      if (!viewer) {
        throw new Error("no owner");
      }
      return viewer;
    };

    /** A fresh folder with AI "full", open to everyone in the shop. */
    const newFolder = async () => {
      const id = randomUUID();
      await database.folder.create({
        data: { id, orgId, name: `HR ${id.slice(0, 6)}`, aiMode: "full" },
      });
      await database.accessGrant.create({
        data: {
          orgId,
          folderId: id,
          principalType: "everyone",
          capabilities: 7,
        },
      });
      return id;
    };

    const setMode = async (folderId: string, mode: string) => {
      expect(
        await settings.setFolderAiMode(await owner(), folderId, mode, {
          confirmed: true,
        })
      ).toEqual({ ok: true });
    };

    /** Lower the folder to "off" (once), marking every later AI call. */
    const lowerOnce = (folderId: string) => async () => {
      if (flags.changed) {
        return;
      }
      await setMode(folderId, "off");
      flags.changed = true;
    };

    const upload = (folderId: string, name: string, body: string) =>
      versions.createDocument(
        orgId,
        "user_owner",
        { name, bytes: h.text(body), mimeType: "text/plain" },
        "upload",
        folderId
      );

    const readInto = async (folderId: string, name: string, body: string) => {
      const made = await upload(folderId, name, body);
      const run = await processing.processVersion(made.versionId);
      return { ...made, run };
    };

    // ~100k characters in paragraphs: well over one context batch (30
    // passages) and six fact windows. The marker is near the end, so it's only
    // in later batches and windows.
    const bigText = () =>
      Array.from(
        { length: 90 },
        (_, i) =>
          `Section ${i}. ${"Employee handbook paragraph text. ".repeat(36)}${
            i > 60 ? `Compensation band ${MARKER} section ${i}.` : ""
          }`
      ).join("\n\n");

    const contexts = (sourceId: string) =>
      database.$queryRawUnsafe<{ context: string | null; embedded: boolean }[]>(
        `select meta ->> 'context' as context, embedding is not null as embedded
       from "DocChunk" where "sourceId" = $1 order by ordinal`,
        sourceId
      );

    const checkpointOf = async (versionId: string) =>
      (
        await database.documentVersion.findUniqueOrThrow({
          where: { id: versionId },
          select: { checkpoint: true },
        })
      ).checkpoint as Record<string, unknown> | null;

    const factsFrom = (sourceId: string) =>
      database.fact.findMany({
        where: { orgId, sources: { some: { sourceId } } },
        select: { id: true },
      });

    /** Facts (any status) whose value carries the marker. */
    const markerFacts = () =>
      database.$queryRawUnsafe<{ id: string }[]>(
        `select id from "Fact" where "orgId" = $1 and value::text like $2`,
        orgId,
        `%${MARKER}%`
      );

    const of = (kind: string) => sent.filter((s) => s.kind === kind);

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      process.env.SKIP_ENV_VALIDATION = "true";
      ({ database } = await import("@repo/database"));
      versions = await import("../lib/library/versions");
      processing = await import("../lib/library/process");
      settings = await import("../lib/library/ai-settings");
      viewers = await import("../lib/library/viewer");
      aiAccess = await import("../lib/library/ai-access");
      lease = await import("../lib/library/lease");
      sweep = await import("../lib/library/sweep");
      lifecycle = await import("../lib/library/lifecycle");
      members.set(`${orgId}:user_owner`, "admin");
      await database.org.create({
        data: {
          id: orgId,
          name: "Audit AI off",
          ownerUserId: "user_owner",
          libraryStage: "confidential",
        },
      });
      await database.part.create({ data: { orgId, partNo: "P-1001" } });
    });

    beforeEach(() => {
      h.resetState();
      sent.length = 0;
      proposed.length = 0;
      flags.changed = false;
      during.understand = null;
      during.context = null;
      during.facts = null;
      during.subject = null;
    });

    afterAll(async () => {
      await database?.org.deleteMany({ where: { id: orgId } });
    });

    test(
      "M2 (control): with AI on, a long document is given context in several batches and read in several fact windows",
      async () => {
        const folder = await newFolder();
        const made = await readInto(folder, "Handbook0.txt", bigText());
        expect(made.run.result).toBe("done");
        expect(of("context").length).toBeGreaterThan(1);
        expect(of("context").some((s) => s.prompt.includes(MARKER))).toBe(true);
        expect(of("facts").length).toBeGreaterThan(1);
        expect(
          (await contexts(made.sourceId)).filter((p) => p.context).length
        ).toBeGreaterThan(0);
      },
      SLOW
    );

    test(
      "M2: lowering AI during the first context batch stops every later batch, and no context sentence is kept",
      async () => {
        const folder = await newFolder();
        during.context = lowerOnce(folder);
        const made = await readInto(folder, "Handbook1.txt", bigText());
        expect(made.run.result).toBe("done");
        expect(flags.changed).toBe(true);
        // Only the batch that was already on its way; nothing after lowering.
        expect(of("context")).toHaveLength(1);
        expect(sent.filter((s) => s.after)).toEqual([]);
        expect(sent.some((s) => s.after && s.prompt.includes(MARKER))).toBe(
          false
        );
        const passages = await contexts(made.sourceId);
        expect(passages.length).toBeGreaterThan(1);
        for (const p of passages) {
          expect(p).toEqual({ context: null, embedded: false });
        }
        const source = await database.source.findUniqueOrThrow({
          where: { id: made.sourceId },
          select: { summary: true },
        });
        expect(source.summary ?? "").not.toContain("AI summary");
        expect(await factsFrom(made.sourceId)).toEqual([]);
      },
      SLOW
    );

    test(
      "M2: lowering AI during the first fact window stops every later window, and no fact read is stored",
      async () => {
        const folder = await newFolder();
        h.state.facts = [
          {
            subjectType: "part",
            partNo: "P-1001",
            attribute: "note",
            value: `Pay band ${MARKER}`,
            quote: `Pay band ${MARKER}`,
          },
        ];
        during.facts = lowerOnce(folder);
        const made = await readInto(folder, "Handbook2.txt", bigText());
        expect(made.run.result).toBe("done");
        expect(flags.changed).toBe(true);
        expect(of("facts")).toHaveLength(1);
        expect(sent.filter((s) => s.after)).toEqual([]);
        expect(await factsFrom(made.sourceId)).toEqual([]);
        expect(await markerFacts()).toEqual([]);
        const checkpoint = await checkpointOf(made.versionId);
        expect(checkpoint?.facts ?? []).toEqual([]);
        expect(checkpoint).not.toHaveProperty("understanding");
      },
      SLOW
    );

    test(
      "L1: a fact proposed while AI is lowered doesn't survive, and doesn't come back when AI is raised",
      async () => {
        const folder = await newFolder();
        h.state.facts = [
          {
            subjectType: "part",
            partNo: "P-1001",
            attribute: "note",
            value: `Pay band ${MARKER}`,
            quote: `Pay band ${MARKER}`,
          },
          {
            subjectType: "part",
            partNo: "P-1001",
            attribute: "note",
            value: `Bonus pool ${MARKER}`,
            quote: `Bonus pool ${MARKER}`,
          },
        ];
        // Lowered between the AI reading the fact and it being proposed: the
        // proposal itself doesn't look at the setting.
        during.subject = lowerOnce(folder);
        const made = await readInto(
          folder,
          "Bands.txt",
          `Pay band ${MARKER}. Bonus pool ${MARKER}.`
        );
        expect(made.run.result).toBe("done");
        expect(flags.changed).toBe(true);
        // The first fact was proposed after lowering (the exploit's step), and
        // the run stopped there: the second never was.
        expect(proposed).toEqual([`Pay band ${MARKER}`]);
        expect(await factsFrom(made.sourceId)).toEqual([]);
        expect(await markerFacts()).toEqual([]);
        expect(
          await database.factSource.count({
            where: { orgId, sourceId: made.sourceId },
          })
        ).toBe(0);
        // Nor what the run had saved to propose next (L10).
        const checkpoint = await checkpointOf(made.versionId);
        for (const key of AI_KEYS) {
          expect(checkpoint).not.toHaveProperty(key);
        }
        // Raising AI again brings nothing back for anyone.
        await setMode(folder, "full");
        expect(await markerFacts()).toEqual([]);
        const visible = await aiAccess.factAccess(viewers.systemViewer(orgId));
        expect((await markerFacts()).filter((f) => visible.has(f.id))).toEqual(
          []
        );
      },
      SLOW
    );

    test(
      "L10: lowering AI strips the AI summary and facts from every checkpoint of the folder's documents",
      async () => {
        const folder = await newFolder();
        h.state.facts = [
          {
            subjectType: "part",
            partNo: "P-1001",
            attribute: "note",
            value: `Kept note ${MARKER}`,
            quote: `Kept note ${MARKER}`,
          },
        ];
        const made = await readInto(folder, "Kept.txt", `Kept note ${MARKER}.`);
        expect(made.run.result).toBe("done");
        const before = await checkpointOf(made.versionId);
        // The exploit's precondition: the run saved what AI returned.
        expect(JSON.stringify(before)).toContain("AI summary of");
        expect(before).toHaveProperty("facts");
        await setMode(folder, "off");
        const after = await checkpointOf(made.versionId);
        for (const key of AI_KEYS) {
          expect(after).not.toHaveProperty(key);
        }
        expect(JSON.stringify(after)).not.toContain("AI summary of");
        expect(JSON.stringify(after)).not.toContain(MARKER);
        // Progress that isn't from AI stays.
        expect(after).toHaveProperty("recognized");
      },
      SLOW
    );

    test(
      "L10: a run that saves progress after AI was lowered can't write the AI summary or facts back",
      async () => {
        const folder = await newFolder();
        const made = await upload(folder, "Resume.txt", `Resume ${MARKER}.`);
        const held = await lease.claimVersion(made.versionId);
        expect(held).not.toBeNull();
        if (!held) {
          return;
        }
        try {
          await setMode(folder, "off");
          await lease.saveProgress(held, {
            stage: "chunk",
            checkpoint: {
              recognized: 0,
              unread: 0,
              understanding: {
                card: { summary: `AI summary of ${MARKER}` },
                linked: [],
                unmatched: [],
              },
              facts: [{ value: MARKER }],
              factsDone: 0,
              tally: {
                proposed: [MARKER],
                conflicts: 0,
                confirmed: 0,
                skipped: 0,
              },
            },
          });
          const saved = await checkpointOf(made.versionId);
          for (const key of AI_KEYS) {
            expect(saved).not.toHaveProperty(key);
            expect(held.version.checkpoint).not.toHaveProperty(key);
          }
          expect(JSON.stringify(saved)).not.toContain(MARKER);
          expect(saved).toEqual({ recognized: 0, unread: 0 });
        } finally {
          await lease.releaseLease(held);
        }
      },
      SLOW
    );

    test(
      "L9: a queued version of a trashed document isn't claimed or swept, and nothing is sent; restoring makes it processable",
      async () => {
        const folder = await newFolder();
        const made = await upload(folder, "Trashed.txt", `Trashed ${MARKER}.`);
        const viewer = await owner();
        expect(await lifecycle.trashDocument(viewer, made.sourceId)).toEqual({
          ok: true,
        });
        expect(await lease.claimVersion(made.versionId)).toBeNull();
        expect(
          (await sweep.dueVersions([orgId])).map((v) => v.id)
        ).not.toContain(made.versionId);
        expect(await processing.processVersion(made.versionId)).toEqual({
          result: "busy",
        });
        await sweep.sweepLibrary({ orgId });
        expect(sent).toEqual([]);
        const version = await database.documentVersion.findUniqueOrThrow({
          where: { id: made.versionId },
          select: { status: true },
        });
        expect(version.status).toBe("queued");

        expect(
          await lifecycle.restoreDocument(viewer, made.sourceId)
        ).toMatchObject({ ok: true });
        expect((await sweep.dueVersions([orgId])).map((v) => v.id)).toContain(
          made.versionId
        );
        const run = await processing.processVersion(made.versionId);
        expect(run.result).toBe("done");
        expect(of("understand")).toHaveLength(1);
      },
      SLOW
    );

    test(
      "L9: trashing a document while it's being understood hands the run off before any further AI call",
      async () => {
        const folder = await newFolder();
        const made = await upload(folder, "Midway.txt", bigText());
        const viewer = await owner();
        during.understand = async () => {
          await lifecycle.trashDocument(viewer, made.sourceId);
          flags.changed = true;
        };
        const run = await processing.processVersion(made.versionId);
        expect(run).toEqual({ result: "handoff" });
        expect(of("understand")).toHaveLength(1);
        expect(sent.filter((s) => s.after)).toEqual([]);
        const version = await database.documentVersion.findUniqueOrThrow({
          where: { id: made.versionId },
          select: { status: true, leaseOwner: true, checkpoint: true },
        });
        expect(version).toMatchObject({ status: "queued", leaseOwner: null });
        expect(version.checkpoint).not.toHaveProperty("understanding");
        // And it waits in the Trash: no run picks it up again.
        expect(await lease.claimVersion(made.versionId)).toBeNull();
      },
      SLOW
    );

    test(
      "L9: trashing a document during its first context batch stops every later batch",
      async () => {
        const folder = await newFolder();
        const made = await upload(folder, "Batches.txt", bigText());
        const viewer = await owner();
        during.context = async () => {
          if (flags.changed) {
            return;
          }
          await lifecycle.trashDocument(viewer, made.sourceId);
          flags.changed = true;
        };
        const run = await processing.processVersion(made.versionId);
        expect(run).toEqual({ result: "handoff" });
        expect(of("context")).toHaveLength(1);
        expect(sent.filter((s) => s.after)).toEqual([]);
        expect(await contexts(made.sourceId)).toEqual([]);
        const version = await database.documentVersion.findUniqueOrThrow({
          where: { id: made.versionId },
          select: { status: true },
        });
        expect(version.status).toBe("queued");
      },
      SLOW
    );
  }
);
