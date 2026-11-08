// @vitest-environment node
// Recoverable document processing against a real database (Knowledge Hub
// phase 2): one run at a time holds a version's lease, a stopped run is
// resumed by the sweep from its last saved stage without reading pages or
// writing passages and facts twice, failures are retried a few times and
// then left for a person, and abandoned uploads are cleaned up. Runs only
// with TEST_DATABASE_URL.
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

describe.skipIf(!TEST_DATABASE_URL)("document processing (database)", () => {
  let database: Db["database"];
  let ingest: typeof import("../lib/knowledge/ingest");
  let versions: typeof import("../lib/library/versions");
  let processing: typeof import("../lib/library/process");
  let lease: typeof import("../lib/library/lease");
  let stages: typeof import("../lib/library/stages");
  let sweep: typeof import("../lib/library/sweep");
  let documents: typeof import("../lib/knowledge/documents");
  let orgId = "";

  const steps: { type: string; text?: string; error?: string }[] = [];
  const emit = (e: { type: string }) => steps.push(e);

  /** A new document (version 1), queued but not processed yet. */
  const queued = (name: string, body = `${name} body text.`) =>
    versions.createDocument(
      orgId,
      "user_planner",
      { name, bytes: h.text(body), mimeType: "text/plain" },
      "upload"
    );

  const version = (id: string) =>
    database.documentVersion.findUniqueOrThrow({ where: { id } });

  /** Make a waiting retry due now (instead of in a minute). */
  const dueNow = (id: string) =>
    database.$executeRawUnsafe(
      `update "DocumentVersion" set "nextAttemptAt" = now() - interval '1 second' where id = $1`,
      id
    );

  /** As if the run holding the lease had stopped and its lease ran out. */
  const expireLease = (id: string) =>
    database.$executeRawUnsafe(
      `update "DocumentVersion" set "leaseUntil" = now() - interval '1 second' where id = $1`,
      id
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SKIP_ENV_VALIDATION = "true";
    ({ database } = await import("@repo/database"));
    ingest = await import("../lib/knowledge/ingest");
    versions = await import("../lib/library/versions");
    processing = await import("../lib/library/process");
    lease = await import("../lib/library/lease");
    stages = await import("../lib/library/stages");
    sweep = await import("../lib/library/sweep");
    documents = await import("../lib/knowledge/documents");
  });

  beforeEach(async () => {
    h.resetState();
    steps.length = 0;
    orgId = `org_proc_${randomUUID().slice(0, 8)}`;
    await database.org.create({ data: { id: orgId, name: "Processing" } });
    await database.part.create({ data: { orgId, partNo: "P-1001" } });
    h.state.session.orgId = orgId;
  });

  afterAll(async () => {
    await database?.org.deleteMany({
      where: { id: { startsWith: "org_proc_" } },
    });
  });

  describe("leases", () => {
    test("two runs claiming the same version: only one gets it", async () => {
      const made = await queued("Claimed.txt");
      const claims = await Promise.all([
        lease.claimVersion(made.versionId),
        lease.claimVersion(made.versionId),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect((await processing.processVersion(made.versionId)).result).toBe(
        "busy"
      );
    });

    test("a lease is renewed as work goes on, and an expired one passes to the next run", async () => {
      const made = await queued("Leased.txt");
      const first = await lease.claimVersion(made.versionId);
      if (!first) {
        throw new Error("expected a lease");
      }
      await database.$executeRawUnsafe(
        `update "DocumentVersion" set "leaseUntil" = now() + interval '5 seconds' where id = $1`,
        made.versionId
      );
      await lease.renewLease(first);
      const renewed = await version(made.versionId);
      expect(renewed.leaseUntil?.getTime()).toBeGreaterThan(
        Date.now() + 4 * 60_000
      );

      // The run stops; its lease runs out.
      await expireLease(made.versionId);
      const second = await lease.claimVersion(made.versionId);
      expect(second).not.toBeNull();
      // A run that stopped counts as an attempt.
      expect((await version(made.versionId)).attempts).toBe(1);
      // The first run can no longer save anything.
      await expect(lease.renewLease(first)).rejects.toBeInstanceOf(
        lease.LeaseLost
      );
      await expect(
        lease.saveProgress(first, { stage: "chunk" })
      ).rejects.toBeInstanceOf(lease.LeaseLost);
      expect((await version(made.versionId)).stage).toBe("read");
    });

    test("a shop has at most three documents processing; other shops aren't held up", async () => {
      const made = await Promise.all(
        ["A", "B", "C", "D"].map((n) => queued(`Doc ${n}.txt`))
      );
      const held: unknown[] = [];
      for (const m of made.slice(0, 3)) {
        held.push(await lease.claimVersion(m.versionId));
      }
      expect(held.every(Boolean)).toBe(true);
      expect(await lease.claimVersion(made[3].versionId)).toBeNull();

      const otherOrg = `org_proc_other_${randomUUID().slice(0, 8)}`;
      await database.org.create({ data: { id: otherOrg, name: "Other" } });
      const theirs = await versions.createDocument(
        otherOrg,
        null,
        { name: "Theirs.txt", bytes: h.text("x"), mimeType: "text/plain" },
        "upload"
      );
      expect(await lease.claimVersion(theirs.versionId)).not.toBeNull();
    });
  });

  describe("recovering stopped and failed work", () => {
    test("OCR that fails part-way resumes without reading pages again or duplicating anything", async () => {
      h.state.pages.set("Scan.pdf", [
        { page: 1, text: "Cover page text layer." },
        { page: 2, text: "Scanned page two.", scanned: true },
        { page: 3, text: "Scanned page three.", scanned: true },
        { page: 4, text: "Scanned page four.", scanned: true },
      ]);
      h.state.failOcr.add(3);
      h.state.facts = [
        {
          subjectType: "part",
          partNo: "P-1001",
          attribute: "note",
          value: "Deburr after op 20",
          quote: "Deburr after op 20",
        },
      ];
      await expect(
        ingest.ingestDocument(
          orgId,
          "user_planner",
          { name: "Scan.pdf", bytes: h.pdf("scan") },
          emit,
          { via: "upload" }
        )
      ).rejects.toThrow("Takumo will try again");
      const v = await database.documentVersion.findFirstOrThrow({
        where: { orgId },
      });
      expect(v).toMatchObject({ status: "failed", stage: "read", attempts: 1 });
      // Page 2 was read and saved before page 3 failed.
      expect(
        await database.documentPage.findMany({
          where: { versionId: v.id },
          select: { page: true, recognized: true },
        })
      ).toEqual([{ page: 2, recognized: true }]);
      expect(h.state.ocrCalls).toEqual([2]);

      // The retry falls due; the sweep resumes it (the browser is long gone).
      await dueNow(v.id);
      // The sweep covers every shop; this version is one it finished.
      const swept = await sweep.sweepLibrary({ orgId });
      expect(swept.results.done).toBeGreaterThanOrEqual(1);
      expect(h.state.ocrCalls).toEqual([2, 3, 4]);
      expect(await version(v.id)).toMatchObject({
        status: "ready",
        stage: "done",
      });
      const pages = await database.documentPage.findMany({
        where: { versionId: v.id },
        orderBy: { position: "asc" },
        select: { page: true, recognized: true },
      });
      expect(pages).toEqual([
        { page: 1, recognized: false },
        { page: 2, recognized: true },
        { page: 3, recognized: true },
        { page: 4, recognized: true },
      ]);
      expect(await database.fact.count({ where: { orgId } })).toBe(1);
      expect(await database.factSource.count({ where: { orgId } })).toBe(1);
    });

    test("a run that stops after a stage (timeout, crash) is resumed from there by the sweep", async () => {
      const made = await queued("Stopped.txt");
      const held = await lease.claimVersion(made.versionId);
      if (!held) {
        throw new Error("expected a lease");
      }
      const run = {
        lease: held,
        emit,
        options: {},
        checkTime: () => undefined,
      };
      await stages.read(run);
      await stages.understand(run);
      await stages.chunk(run);
      const chunks = await database.docChunk.count({
        where: { versionId: made.versionId },
      });
      // Writing the passages again (as a resumed run might) adds none.
      await stages.chunk(run);
      expect(
        await database.docChunk.count({ where: { versionId: made.versionId } })
      ).toBe(chunks);

      // The run dies here. Nothing is current yet.
      await expireLease(made.versionId);
      expect(
        (
          await database.source.findUniqueOrThrow({
            where: { id: made.sourceId },
          })
        ).currentVersionId
      ).toBeNull();
      // The sweep covers every shop; this version is one it finished.
      const swept = await sweep.sweepLibrary({ orgId });
      expect(swept.results.done).toBeGreaterThanOrEqual(1);
      expect(await version(made.versionId)).toMatchObject({
        status: "ready",
        attempts: 1,
      });
      expect(
        await database.docChunk.count({ where: { versionId: made.versionId } })
      ).toBe(chunks);
      expect(
        (
          await database.source.findUniqueOrThrow({
            where: { id: made.sourceId },
          })
        ).currentVersionId
      ).toBe(made.versionId);
    });

    test("out of time: the run saves, hands off, and the next run finishes", async () => {
      const made = await queued("Long.txt");
      const run = await processing.processVersion(made.versionId, {
        emit,
        deadline: Date.now() - 1,
      });
      expect(run.result).toBe("handoff");
      expect(steps.at(-1)).toMatchObject({ type: "done", background: true });
      expect(await version(made.versionId)).toMatchObject({
        status: "queued",
        leaseOwner: null,
      });
      expect((await processing.processVersion(made.versionId)).result).toBe(
        "done"
      );
    });

    test("failed embeddings are retried, then left failed for a person; a first version gives its name back", async () => {
      h.state.embedFailures = 10;
      const made = await queued("Flaky.txt");
      for (const attempt of [1, 2, 3]) {
        const run = await processing.processVersion(made.versionId);
        expect(run).toMatchObject({ result: "failed", retry: attempt < 3 });
        if (attempt < 3) {
          await dueNow(made.versionId);
        }
      }
      const v = await version(made.versionId);
      expect(v).toMatchObject({ status: "failed", attempts: 3 });
      expect(v.nextAttemptAt).toBeNull();
      expect(await lease.claimVersion(made.versionId)).toBeNull();
      // It never became readable: it waits in the Trash, its name is free.
      const source = await database.source.findUniqueOrThrow({
        where: { id: made.sourceId },
      });
      expect(source.deletedAt).not.toBeNull();
      expect(await documents.documentNamed(orgId, "Flaky.txt")).toBeNull();
      // Someone retries it once the provider is back.
      h.state.embedFailures = 0;
      expect(
        await lease.requeueVersion(orgId, made.sourceId, made.versionId)
      ).toBe(true);
      expect((await processing.processVersion(made.versionId)).result).toBe(
        "done"
      );
    });

    test("a file with no text fails at once; retrying can't help", async () => {
      const made = await queued("Blank.txt", "   ");
      const run = await processing.processVersion(made.versionId);
      expect(run).toEqual({
        result: "failed",
        error: "No text found in that file.",
        retry: false,
      });
      expect((await version(made.versionId)).nextAttemptAt).toBeNull();
    });

    test("a version whose runs keep stopping is marked failed", async () => {
      const made = await queued("Crashy.txt");
      await lease.claimVersion(made.versionId);
      await database.$executeRawUnsafe(
        `update "DocumentVersion" set attempts = 2, "leaseUntil" = now() - interval '1 second' where id = $1`,
        made.versionId
      );
      expect(await lease.claimVersion(made.versionId)).toBeNull();
      await sweep.sweepLibrary({ orgId });
      expect(await version(made.versionId)).toMatchObject({
        status: "failed",
        leaseOwner: null,
      });
    });

    test("an upload abandoned before its file was stored is removed, file and all", async () => {
      const sourceId = randomUUID();
      const key = `org/${orgId}/src/${sourceId}/v1/${"a".repeat(64)}`;
      await database.source.create({
        data: {
          id: sourceId,
          orgId,
          name: "Abandoned",
          type: "upload",
          profile: "document",
          versionSeq: 1,
        },
      });
      const v = await database.documentVersion.create({
        data: {
          orgId,
          sourceId,
          number: 1,
          name: "Abandoned.pdf",
          storageKey: key,
          createdAt: new Date(Date.now() - 2 * 60 * 60_000),
        },
      });
      await h.state.store?.put(key, h.pdf("x"), "application/pdf");
      await sweep.sweepLibrary({ orgId });
      expect(
        await database.documentVersion.count({ where: { id: v.id } })
      ).toBe(0);
      expect(await database.source.count({ where: { id: sourceId } })).toBe(0);
      // Its file goes on the next pass (or this one, once due).
      await database.storageDeletion.updateMany({
        where: { orgId },
        data: { nextAttemptAt: new Date(0) },
      });
      await sweep.sweepLibrary({ orgId });
      expect(h.state.store?.objects.has(key)).toBe(false);
      expect(await database.storageDeletion.count({ where: { orgId } })).toBe(
        0
      );
    });
  });
});
