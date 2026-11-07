// @vitest-environment node
// The Knowledge Hub's phase 2 failure scenarios found in review, against a
// real database: an activation stopped right after it committed, a run that
// lost its lease, long steps that need their lease kept alive, one shop's
// backlog, reading without Storage, and permanent deletes racing uploads,
// audit entries and answers being saved. Runs only with TEST_DATABASE_URL.
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
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
// Runs inside "understand", so a test can act in the middle of a run.
const during = vi.hoisted(() => ({
  understand: null as null | (() => Promise<void>),
}));

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
  understandDocument: async (_org: string, name: string) => {
    await during.understand?.();
    return {
      card: {
        docType: "sop",
        title: name,
        revision: null,
        summary: `About ${name}.`,
        mentions: [],
      },
      linked: [],
      unmatched: [],
    };
  },
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FACT = {
  subjectType: "part",
  partNo: "P-1001",
  attribute: "note",
  value: "Deburr after op 20",
  quote: "Deburr after op 20",
};

describe.skipIf(!TEST_DATABASE_URL)(
  "phase 2 failure scenarios (database)",
  () => {
    let database: Db["database"];
    let versions: typeof import("../lib/library/versions");
    let processing: typeof import("../lib/library/process");
    let lease: typeof import("../lib/library/lease");
    let stages: typeof import("../lib/library/stages");
    let sweep: typeof import("../lib/library/sweep");
    let lifecycle: typeof import("../lib/library/lifecycle");
    let auditing: typeof import("../lib/library/audit");
    let provenance: typeof import("../lib/library/provenance");
    let citations: typeof import("../lib/agent/citations");
    let orgId = "";

    const queued = (name: string, body = `${name} body text.`, org = orgId) =>
      versions.createDocument(
        org,
        "user_planner",
        { name, bytes: h.text(body), mimeType: "text/plain" },
        "upload"
      );

    const version = (id: string) =>
      database.documentVersion.findUniqueOrThrow({ where: { id } });

    /** Claim a version and run its stages up to (not including) activation. */
    const upToActivation = async (versionId: string) => {
      const held = await lease.claimVersion(versionId);
      if (!held) {
        throw new Error("expected a lease");
      }
      const run = {
        lease: held,
        emit: () => undefined,
        options: {},
        checkTime: () => undefined,
      };
      for (const stage of [
        stages.read,
        stages.understand,
        stages.chunk,
        stages.embed,
      ]) {
        await stage(run);
      }
      return run;
    };

    /** Another run takes the lease (as after the first one's ran out). */
    const steal = (versionId: string) =>
      database.documentVersion.update({
        where: { id: versionId },
        data: { leaseOwner: randomUUID() },
      });

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      process.env.SKIP_ENV_VALIDATION = "true";
      ({ database } = await import("@repo/database"));
      versions = await import("../lib/library/versions");
      processing = await import("../lib/library/process");
      lease = await import("../lib/library/lease");
      stages = await import("../lib/library/stages");
      sweep = await import("../lib/library/sweep");
      lifecycle = await import("../lib/library/lifecycle");
      auditing = await import("../lib/library/audit");
      provenance = await import("../lib/library/provenance");
      citations = await import("../lib/agent/citations");
    });

    beforeEach(async () => {
      h.resetState();
      during.understand = null;
      orgId = `org_race_${randomUUID().slice(0, 8)}`;
      await database.org.create({ data: { id: orgId, name: "Races" } });
      await database.part.create({ data: { orgId, partNo: "P-1001" } });
      h.state.session.orgId = orgId;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    afterAll(async () => {
      await database?.org.deleteMany({
        where: { id: { startsWith: "org_race_" } },
      });
    });

    describe("activation", () => {
      test("stopped right after activation committed: the sweep finishes it, facts proposed once", async () => {
        h.state.facts = [FACT];
        const made = await queued("Stopped late.txt");
        const run = await upToActivation(made.versionId);
        expect(await stages.activate(run)).toBe("active");
        // The run dies before proposing facts; its lease runs out.
        await database.$executeRawUnsafe(
          `update "DocumentVersion" set "leaseUntil" = now() - interval '1 second' where id = $1`,
          made.versionId
        );
        expect(await version(made.versionId)).toMatchObject({
          status: "processing",
          stage: "facts",
        });
        // Searchable already: it went live in that transaction.
        expect(
          (
            await database.source.findUniqueOrThrow({
              where: { id: made.sourceId },
            })
          ).currentVersionId
        ).toBe(made.versionId);
        await sweep.sweepLibrary({ orgId });
        expect(await version(made.versionId)).toMatchObject({
          status: "ready",
          stage: "done",
        });
        expect(await database.fact.count({ where: { orgId } })).toBe(1);
        // A second sweep changes nothing.
        await sweep.sweepLibrary({ orgId });
        expect(await database.fact.count({ where: { orgId } })).toBe(1);
      });

      test("a run that lost its lease can't activate: the document stays as it was", async () => {
        const made = await queued("Lost.txt");
        const run = await upToActivation(made.versionId);
        await steal(made.versionId);
        await expect(stages.activate(run)).rejects.toBeInstanceOf(
          lease.LeaseLost
        );
        const source = await database.source.findUniqueOrThrow({
          where: { id: made.sourceId },
        });
        expect(source.currentVersionId).toBeNull();
        expect((await version(made.versionId)).activatedAt).toBeNull();
      });

      test("an older version that finds a newer one live is finished as history at once", async () => {
        const first = await queued("History.txt", "Version one.");
        await processing.processVersion(first.versionId);
        const file = (body: string) => ({
          name: "History.txt",
          bytes: h.text(body),
          mimeType: "text/plain",
        });
        const v2 = await versions.createVersion(
          orgId,
          "user_planner",
          first.sourceId,
          file("Version two.")
        );
        const v3 = await versions.createVersion(
          orgId,
          "user_planner",
          first.sourceId,
          file("Version three.")
        );
        await processing.processVersion(v3?.versionId ?? "");
        const run = await upToActivation(v2?.versionId ?? "");
        expect(await stages.activate(run)).toBe("superseded");
        // Final in the same transaction: a stop right here leaves nothing to redo.
        expect(await version(v2?.versionId ?? "")).toMatchObject({
          status: "superseded",
          stage: "done",
          leaseOwner: null,
        });
        expect(await lease.claimVersion(v2?.versionId ?? "")).toBeNull();
      });

      test("a run that lost its lease proposes no facts and doesn't finish", async () => {
        h.state.facts = [FACT];
        const made = await queued("Stale facts.txt");
        const run = await upToActivation(made.versionId);
        await stages.activate(run);
        // The facts were read and saved; then the lease passes to another run.
        await lease.saveProgress(run.lease, {
          stage: "facts",
          checkpoint: { facts: [FACT], factsDone: 0 },
        });
        await steal(made.versionId);
        await expect(stages.facts(run)).rejects.toBeInstanceOf(lease.LeaseLost);
        expect(await database.fact.count({ where: { orgId } })).toBe(0);
        expect((await version(made.versionId)).status).toBe("processing");
      });

      test("a document moved to the Trash while processing gets no facts proposed", async () => {
        h.state.facts = [FACT];
        const made = await queued("Trashed meanwhile.txt");
        await database.source.update({
          where: { id: made.sourceId },
          data: { deletedAt: new Date() },
        });
        expect((await processing.processVersion(made.versionId)).result).toBe(
          "done"
        );
        expect(await database.fact.count({ where: { orgId } })).toBe(0);
      });
    });

    describe("leases and the sweep", () => {
      test("a long step keeps its lease alive, and the run stops once it's lost", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const made = await queued("Slow.txt");
        const extended: boolean[] = [];
        during.understand = async () => {
          // The lease is about to run out in the middle of a long AI call…
          await database.$executeRawUnsafe(
            `update "DocumentVersion" set "leaseUntil" = now() + interval '10 seconds' where id = $1`,
            made.versionId
          );
          await vi.advanceTimersByTimeAsync(processing.HEARTBEAT_MS);
          await sleep(100);
          const renewed = await version(made.versionId);
          extended.push(
            (renewed.leaseUntil?.getTime() ?? 0) > Date.now() + 4 * 60_000
          );
          // …then another run takes it over.
          await steal(made.versionId);
          await vi.advanceTimersByTimeAsync(processing.HEARTBEAT_MS);
          await sleep(100);
        };
        const run = await processing.processVersion(made.versionId);
        expect(extended).toEqual([true]);
        expect(run.result).toBe("lost");
        // It stopped before writing any passages.
        expect(
          await database.docChunk.count({
            where: { versionId: made.versionId },
          })
        ).toBe(0);
      });

      test("one shop's backlog doesn't keep another shop waiting", async () => {
        for (let i = 0; i < 22; i += 1) {
          await queued(`Backlog ${i}.txt`);
        }
        const otherOrg = `org_race_other_${randomUUID().slice(0, 8)}`;
        await database.org.create({ data: { id: otherOrg, name: "Other" } });
        const theirs = await queued("Theirs.txt", "Their text.", otherOrg);
        const due = new Set(
          (await sweep.dueVersions([orgId, otherOrg])).map((d) => d.id)
        );
        expect(due.has(theirs.versionId)).toBe(true);
        const ours = await database.documentVersion.findMany({
          where: { orgId },
          select: { id: true },
        });
        expect(ours.filter((v) => due.has(v.id)).length).toBeLessThanOrEqual(
          lease.SHOP_LIMIT
        );
      });

      test("without Storage, a long read isn't handed off half-way (the next run couldn't read the file)", async () => {
        h.state.store = null;
        h.state.pages.set("Scan.pdf", [
          { page: 1, text: "Cover." },
          { page: 2, text: "Scanned two.", scanned: true },
          { page: 3, text: "Scanned three.", scanned: true },
          { page: 4, text: "Scanned four.", scanned: true },
        ]);
        h.state.ocrDelayMs = 40;
        const made = await versions.createDocument(
          orgId,
          "user_planner",
          {
            name: "Scan.pdf",
            bytes: h.pdf("scan"),
            mimeType: "application/pdf",
          },
          "upload"
        );
        const first = await processing.processVersion(made.versionId, {
          bytes: h.pdf("scan"),
          deadline: Date.now() + 60,
        });
        expect(first.result).toBe("handoff");
        expect(await version(made.versionId)).toMatchObject({
          stage: "understand",
          pageCount: 4,
        });
        expect((await processing.processVersion(made.versionId)).result).toBe(
          "done"
        );
      });
    });

    describe("permanent delete racing other work", () => {
      test("an upload whose document is deleted while its file is stored leaves no file behind", async () => {
        const store = h.state.store;
        if (!store) {
          throw new Error("expected a store");
        }
        store.put.mockImplementationOnce(
          async (key: string, bytes: Uint8Array) => {
            // The document is deleted (and its files cleaned up) meanwhile.
            await database.source.deleteMany({ where: { orgId } });
            store.objects.set(key, { bytes, contentType: "text/plain" });
          }
        );
        await expect(queued("Gone.txt")).rejects.toThrow(
          "That document was deleted while the file was uploading."
        );
        const [key] = [...store.objects.keys()];
        const pending = await database.storageDeletion.findMany({
          where: { orgId },
        });
        expect(pending.flatMap((p) => p.keys)).toEqual([key]);
        expect(
          await database.documentAuditLog.count({
            where: { orgId, subjectName: { not: null } },
          })
        ).toBe(0);
      });

      test("an audit entry written while a delete commits keeps no name", async () => {
        const made = await queued("Secret plan.txt");
        const deleting = database.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(
            `select id from "Source" where id = $1 for update`,
            made.sourceId
          );
          await sleep(200);
          await tx.source.delete({ where: { id: made.sourceId } });
        });
        await sleep(50);
        await auditing.audit({
          orgId,
          actorId: "user_sam",
          action: "download",
          sourceId: made.sourceId,
          subjectName: "Secret plan",
        });
        await deleting;
        const entry = await database.documentAuditLog.findFirstOrThrow({
          where: { orgId, action: "download" },
        });
        expect(entry.subjectName).toBeNull();
      });

      describe("answers", () => {
        const ask = async (sourceId: string) => {
          const conversationId = (
            await database.conversation.create({
              data: { orgId, userId: "user_planner" },
            })
          ).id;
          const tools = [
            {
              tool: "search_documents",
              input: { query: "secret" },
              output: {
                sources: [citations.cite.doc("Secret", 1, sourceId, "secret")],
              },
            },
          ];
          return {
            conversationId,
            worked: await provenance.answerProvenance(
              orgId,
              conversationId,
              tools
            ),
          };
        };

        /** Save an answer as the ask route does; `pause` holds the transaction open. */
        const save = (
          conversationId: string,
          worked: Awaited<ReturnType<typeof ask>>["worked"],
          pause = 0
        ) =>
          database.$transaction(async (tx) => {
            const found = await provenance.settleSources(tx, orgId, worked);
            const message = await tx.message.create({
              data: {
                conversationId,
                role: "assistant",
                content: "The secret is 42.",
                provenance: found.provenance,
                ...(found.gone ? provenance.removedAnswer() : {}),
              },
            });
            await provenance.recordAnswerSources(
              tx,
              orgId,
              conversationId,
              message.id,
              found
            );
            await sleep(pause);
            return message.id;
          });

        test("an answer worked out before a document was deleted is saved as removed", async () => {
          const made = await queued("Secret.txt", "The secret is 42.");
          await processing.processVersion(made.versionId);
          const { conversationId, worked } = await ask(made.sourceId);
          expect(worked.provenance).toBe("recorded");
          await lifecycle.purgeSource(orgId, made.sourceId, null);
          const id = await save(conversationId, worked);
          const saved = await database.message.findUniqueOrThrow({
            where: { id },
          });
          expect(saved).toMatchObject({
            content: provenance.REMOVED_ANSWER,
            provenance: "removed",
          });
          expect(
            await database.messageSource.count({ where: { messageId: id } })
          ).toBe(0);
        });

        test("an answer being saved while the document is deleted is rewritten by the delete", async () => {
          const made = await queued("Secret.txt", "The secret is 42.");
          await processing.processVersion(made.versionId);
          const { conversationId, worked } = await ask(made.sourceId);
          const saving = save(conversationId, worked, 300);
          await sleep(80);
          await lifecycle.purgeSource(orgId, made.sourceId, null);
          const id = await saving;
          expect(
            await database.message.findUniqueOrThrow({ where: { id } })
          ).toMatchObject({
            content: provenance.REMOVED_ANSWER,
            provenance: "removed",
          });
        });
      });
    });
  }
);
