// @vitest-environment node
// Trash, restore and permanent delete against a real database (Knowledge Hub
// phase 2). The Trash hides a document at once and keeps everything;
// restoring handles a name taken meanwhile; permanent delete removes the
// text, passages, vectors, versions, files and the facts and saved answers
// that came from it, and isn't reported complete until storage confirms the
// files are gone. Runs only with TEST_DATABASE_URL.
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

describe.skipIf(!TEST_DATABASE_URL)(
  "trash and permanent delete (database)",
  () => {
    let database: Db["database"];
    let ingest: typeof import("../lib/knowledge/ingest");
    let documents: typeof import("../lib/knowledge/documents");
    let versions: typeof import("../lib/library/versions");
    let processing: typeof import("../lib/library/process");
    let lifecycle: typeof import("../lib/library/lifecycle");
    let viewers: typeof import("../lib/library/viewer");
    let orgId = "";
    const otherOrgId = `org_life_other_${randomUUID().slice(0, 8)}`;

    const viewerAs = async (role: string, userId = `user_${role}`) => {
      h.state.session = { orgId, userId, role };
      const viewer = await viewers.resolveViewer();
      if (!viewer) {
        throw new Error("expected a viewer");
      }
      return viewer;
    };

    const add = async (name: string, body: string) => {
      h.state.session = { orgId, userId: "user_planner", role: "planner" };
      const done = await ingest.ingestDocument(
        orgId,
        "user_planner",
        { name, bytes: h.text(body) },
        () => undefined,
        { via: "upload" }
      );
      return done.sourceId;
    };

    const found = async (word: string) =>
      (
        await documents.searchDocuments(
          (await import("../lib/library/viewer")).systemViewer(orgId),
          word
        )
      ).filter((hit) => hit.snippet.toLowerCase().includes(word.toLowerCase()));

    const actions = async (sourceId: string) =>
      (
        await database.documentAuditLog.findMany({
          where: { orgId, sourceId },
          orderBy: { createdAt: "asc" },
          select: { action: true },
        })
      ).map((a) => a.action);

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      process.env.SKIP_ENV_VALIDATION = "true";
      ({ database } = await import("@repo/database"));
      ingest = await import("../lib/knowledge/ingest");
      documents = await import("../lib/knowledge/documents");
      versions = await import("../lib/library/versions");
      processing = await import("../lib/library/process");
      lifecycle = await import("../lib/library/lifecycle");
      viewers = await import("../lib/library/viewer");
      await database.org.create({ data: { id: otherOrgId, name: "Other" } });
    });

    beforeEach(async () => {
      h.resetState();
      orgId = `org_life_${randomUUID().slice(0, 8)}`;
      await database.org.create({
        data: { id: orgId, name: "Lifecycle", ownerUserId: "user_owner" },
      });
    });

    afterAll(async () => {
      await database?.org.deleteMany({
        where: { id: { startsWith: "org_life_" } },
      });
    });

    describe("trash and restore", () => {
      test("the Trash hides a document at once and keeps it; restoring brings it back", async () => {
        const sourceId = await add(
          "Anodize SOP.txt",
          "Anodize at twenty volts."
        );
        const planner = await viewerAs("planner");
        expect(await found("anodize")).not.toHaveLength(0);

        expect(await lifecycle.trashDocument(planner, sourceId)).toEqual({
          ok: true,
        });
        expect(await found("anodize")).toHaveLength(0);
        expect(
          await documents.documentNamed(orgId, "Anodize SOP.pdf")
        ).toBeNull();
        const trashed = await database.source.findUniqueOrThrow({
          where: { id: sourceId },
          include: { versions: true },
        });
        expect(trashed.deletedBy).toBe("user_planner");
        // Everything is kept for restoring.
        expect(trashed.versions).toHaveLength(1);
        expect(h.state.store?.objects.size).toBe(1);
        // Twice is fine.
        expect(await lifecycle.trashDocument(planner, sourceId)).toEqual({
          ok: true,
        });

        expect(await lifecycle.restoreDocument(planner, sourceId)).toEqual({
          ok: true,
          name: "Anodize SOP",
        });
        expect(await found("anodize")).not.toHaveLength(0);
        expect(await actions(sourceId)).toEqual([
          "upload",
          "processed",
          "trash",
          "restore",
        ]);
      });

      test("an operator can't trash or restore; another shop's document isn't found", async () => {
        const sourceId = await add("Mine.txt", "Mine.");
        const operator = await viewerAs("operator");
        expect(await lifecycle.trashDocument(operator, sourceId)).toMatchObject(
          {
            ok: false,
            status: 403,
          }
        );
        const theirs = await database.source.create({
          data: {
            orgId: otherOrgId,
            name: `Theirs ${randomUUID()}`,
            type: "upload",
            profile: "document",
          },
        });
        const admin = await viewerAs("admin");
        expect(await lifecycle.trashDocument(admin, theirs.id)).toMatchObject({
          ok: false,
          status: 404,
        });
        expect(
          (
            await database.source.findUniqueOrThrow({
              where: { id: theirs.id },
            })
          ).deletedAt
        ).toBeNull();
      });

      test("restoring when the name was taken meanwhile adds (restored)", async () => {
        const first = await add("Fixture plan.txt", "Plan one.");
        const planner = await viewerAs("planner");
        await lifecycle.trashDocument(planner, first);
        const second = await add("Fixture plan.txt", "Plan two.");
        await lifecycle.trashDocument(planner, second);
        await add("Fixture plan.txt", "Plan three.");
        expect(await lifecycle.restoreDocument(planner, first)).toEqual({
          ok: true,
          name: "Fixture plan (restored)",
        });
        expect(await lifecycle.restoreDocument(planner, second)).toEqual({
          ok: true,
          name: "Fixture plan (restored 2)",
        });
        // Its versions came back with it.
        expect(
          await database.documentVersion.count({ where: { sourceId: first } })
        ).toBe(1);
      });
    });

    describe("permanent delete", () => {
      test("needs the Trash first, and manage on the document", async () => {
        const sourceId = await add("Keep.txt", "Keep.");
        const admin = await viewerAs("admin");
        expect(await lifecycle.purgeDocument(admin, sourceId)).toMatchObject({
          ok: false,
          status: 409,
        });
        await lifecycle.trashDocument(admin, sourceId);
        const planner = await viewerAs("planner");
        expect(await lifecycle.purgeDocument(planner, sourceId)).toMatchObject({
          ok: false,
          status: 403,
        });
        expect(await database.source.count({ where: { id: sourceId } })).toBe(
          1
        );
        // The owner on record with a lesser role isn't the owner (G3-F1).
        const demoted = await viewerAs("planner", "user_owner");
        expect(await lifecycle.purgeDocument(demoted, sourceId)).toMatchObject({
          ok: false,
          status: 403,
        });
        const owner = await viewerAs("admin", "user_owner");
        expect(await lifecycle.purgeDocument(owner, sourceId)).toEqual({
          ok: true,
          complete: true,
        });
      });

      test("removes the document and everything derived from it", async () => {
        const sourceId = await add("Pricing.txt", "Machine rate 110.");
        const otherDoc = await add("Rates.txt", "Machine rate list.");
        await versions.createVersion(orgId, "user_planner", sourceId, {
          name: "Pricing v2.txt",
          bytes: h.text("Machine rate 120."),
          mimeType: "text/plain",
        });
        const v2 = await database.documentVersion.findFirstOrThrow({
          where: { sourceId, number: 2 },
        });
        await processing.processVersion(v2.id);
        expect(h.state.store?.objects.size).toBe(3);
        await database.accessGrant.create({
          data: { orgId, sourceId, principalType: "everyone", capabilities: 3 },
        });

        // Facts: from this document only (pending, approved), from both
        // documents, and one from before provenance was recorded.
        const fact = (number: number, status: "pending" | "approved") =>
          database.fact.create({
            data: {
              orgId,
              number,
              subjectType: "shop",
              subjectId: orgId,
              subjectLabel: "Shop",
              attribute: "note",
              value: `fact ${number}`,
              status,
              evidence: `"rate 110" (Pricing)`,
              provenance: "documents",
            },
          });
        const pendingOnly = await fact(1, "pending");
        const approvedOnly = await fact(2, "approved");
        const both = await fact(3, "pending");
        const legacy = await database.fact.create({
          data: {
            orgId,
            number: 4,
            subjectType: "shop",
            subjectId: orgId,
            subjectLabel: "Shop",
            attribute: "note",
            value: "legacy",
            evidence: `"rate 110" (Pricing)`,
          },
        });
        for (const f of [pendingOnly, approvedOnly, both]) {
          await database.factSource.create({
            data: { orgId, factId: f.id, sourceId, quote: "rate 110" },
          });
        }
        await database.factSource.create({
          data: {
            orgId,
            factId: both.id,
            sourceId: otherDoc,
            quote: "rate list",
          },
        });

        // Saved answers: one recorded as using it, an older one linking to
        // it, one about something else, and the person's own question.
        const conversation = await database.conversation.create({
          data: { orgId, userId: "user_planner" },
        });
        const message = (role: string, content: string, extra: object = {}) =>
          database.message.create({
            data: { conversationId: conversation.id, role, content, ...extra },
          });
        const question = await message("user", "What's the rate?", {
          provenance: "recorded",
        });
        const recorded = await message("assistant", "The rate is 110.", {
          provenance: "recorded",
        });
        await database.messageSource.create({
          data: {
            orgId,
            conversationId: conversation.id,
            messageId: recorded.id,
            sourceId,
            direct: true,
            via: "document",
          },
        });
        const older = await message("assistant", "Rate 110 [doc Pricing].", {
          citations: [
            {
              id: "doc Pricing",
              kind: "doc",
              href: `/knowledge#source-${sourceId}`,
            },
          ],
        });
        const unrelated = await message(
          "assistant",
          "Order SO-1 ships Friday.",
          {
            provenance: "recorded",
          }
        );

        const admin = await viewerAs("admin");
        await lifecycle.trashDocument(admin, sourceId);
        expect(await lifecycle.purgeDocument(admin, sourceId)).toEqual({
          ok: true,
          complete: true,
        });

        expect(await database.source.count({ where: { id: sourceId } })).toBe(
          0
        );
        for (const table of [
          database.documentVersion,
          database.docChunk,
          database.accessGrant,
          database.factSource,
        ] as unknown as { count: (a: object) => Promise<number> }[]) {
          expect(await table.count({ where: { sourceId } })).toBe(0);
        }
        expect(
          await database.documentPage.count({ where: { versionId: v2.id } })
        ).toBe(0);
        expect(h.state.store?.objects.size).toBe(1);
        expect(await found("110")).toHaveLength(0);

        expect(
          await database.fact.findUnique({ where: { id: pendingOnly.id } })
        ).toBeNull();
        expect(
          await database.fact.findUniqueOrThrow({
            where: { id: approvedOnly.id },
          })
        ).toMatchObject({ evidence: null, provenance: "source_deleted" });
        expect(
          await database.fact.findUniqueOrThrow({ where: { id: both.id } })
        ).toMatchObject({ evidence: `"rate list" (Rates)` });
        // Never guessed: a fact whose source was never recorded is untouched.
        expect(
          await database.fact.findUniqueOrThrow({ where: { id: legacy.id } })
        ).toMatchObject({ provenance: "unknown" });

        const after = await database.message.findMany({
          where: { conversationId: conversation.id },
          select: {
            id: true,
            content: true,
            citations: true,
            provenance: true,
          },
        });
        const byId = new Map(after.map((m) => [m.id, m]));
        for (const m of [recorded, older]) {
          expect(byId.get(m.id)).toMatchObject({
            content:
              "Removed: this answer used a document that was permanently deleted.",
            citations: null,
            provenance: "removed",
          });
        }
        expect(byId.get(unrelated.id)?.content).toBe(
          "Order SO-1 ships Friday."
        );
        expect(byId.get(question.id)?.content).toBe("What's the rate?");
        expect(
          await database.messageSource.count({ where: { sourceId } })
        ).toBe(0);

        const audit = await database.documentAuditLog.findMany({
          where: { orgId, sourceId },
          select: { action: true, subjectName: true },
        });
        expect(audit.every((a) => a.subjectName === null)).toBe(true);
        expect(audit.map((a) => a.action)).toEqual(
          expect.arrayContaining(["upload", "trash", "purge", "purge_complete"])
        );
      });

      test("when storage can't delete the files it says so, and the sweep finishes later", async () => {
        const sourceId = await add("Payroll.txt", "Payroll cutoff Friday.");
        const admin = await viewerAs("admin");
        await lifecycle.trashDocument(admin, sourceId);
        if (h.state.store) {
          h.state.store.fail.remove = true;
        }
        expect(await lifecycle.purgeDocument(admin, sourceId)).toEqual({
          ok: true,
          complete: false,
        });
        // The data is gone; the file isn't yet, and that's on record.
        expect(await database.source.count({ where: { id: sourceId } })).toBe(
          0
        );
        expect(h.state.store?.objects.size).toBe(1);
        const pending = await database.storageDeletion.findFirstOrThrow({
          where: { orgId, sourceId },
        });
        expect(pending.attempts).toBe(1);
        expect(await actions(sourceId)).not.toContain("purge_complete");

        // Asking again while it's pending: still not complete, nothing breaks.
        expect(await lifecycle.purgeDocument(admin, sourceId)).toEqual({
          ok: true,
          complete: false,
        });

        if (h.state.store) {
          h.state.store.fail.remove = false;
        }
        await database.storageDeletion.updateMany({
          where: { orgId },
          data: { nextAttemptAt: new Date(0) },
        });
        expect(await lifecycle.retryStorageDeletions(20, orgId)).toMatchObject({
          deleted: expect.any(Number),
        });
        expect(h.state.store?.objects.size).toBe(0);
        expect(await database.storageDeletion.count({ where: { orgId } })).toBe(
          0
        );
        expect(await actions(sourceId)).toContain("purge_complete");
        // Done: running it again changes nothing.
        expect(await lifecycle.purgeSource(orgId, sourceId, null)).toEqual({
          complete: true,
        });
      });
    });
  }
);
