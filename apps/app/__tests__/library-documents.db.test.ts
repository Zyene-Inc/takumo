// @vitest-environment node
// Knowledge Hub documents against a real database (phase 2): uploads become
// version 1 with the original kept in private storage, a same-name upload
// never replaces anything, new versions are an explicit action and go live
// only when fully processed (never over a newer one), and original files are
// reached only through a short-lived link made after the checks. Storage is
// an in-memory stand-in; nothing reaches Supabase or an AI provider. Runs
// only with TEST_DATABASE_URL.
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
  shopRole: async (userId: string, orgId: string) =>
    h.state.memberships.get(`${orgId}:${userId}`) ?? null,
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

describe.skipIf(!TEST_DATABASE_URL)("documents and versions (database)", () => {
  let database: Db["database"];
  let upload: typeof import("../app/api/knowledge/upload/route");
  let versionsRoute: typeof import("../app/api/library/documents/[sourceId]/versions/route");
  let fileRoute: typeof import("../app/api/library/documents/[sourceId]/file/route");
  let documents: typeof import("../lib/knowledge/documents");
  let versions: typeof import("../lib/library/versions");
  let processing: typeof import("../lib/library/process");
  let lease: typeof import("../lib/library/lease");
  let stages: typeof import("../lib/library/stages");
  let orgId = "";
  const otherOrgId = `org_docs2_other_${randomUUID().slice(0, 8)}`;

  const as = (role: string, userId = `user_${role}`) => {
    h.state.session = { orgId, userId, role };
  };

  const postUpload = (name: string, bytes: Uint8Array, extra = {}) =>
    upload.POST(
      h.uploadRequest("http://test/api/knowledge/upload", name, bytes, extra)
    );

  const postVersion = (sourceId: string, name: string, bytes: Uint8Array) =>
    versionsRoute.POST(
      h.uploadRequest(
        `http://test/api/library/documents/${sourceId}/versions`,
        name,
        bytes
      ),
      { params: Promise.resolve({ sourceId }) }
    );

  const getFile = (sourceId: string, query = "") =>
    fileRoute.GET(
      new Request(`http://test/api/library/documents/${sourceId}/file${query}`),
      { params: Promise.resolve({ sourceId }) }
    );

  /** Upload as a planner and return the stored document. */
  const uploaded = async (name: string, body: string, bytes = h.text(body)) => {
    const response = await postUpload(name, bytes);
    expect((await h.events(response)).at(-1)?.type).toBe("done");
    return database.source.findFirstOrThrow({
      where: { orgId, name: documents.cleanName(name) },
      include: { versions: { orderBy: { number: "asc" } } },
    });
  };

  /** Search results (keyword and vector) whose text contains the word. */
  const found = async (word: string) =>
    (await documents.searchDocuments(orgId, word))
      .map((hit) => hit.snippet)
      .filter((snippet) => snippet.toLowerCase().includes(word.toLowerCase()));

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SKIP_ENV_VALIDATION = "true";
    ({ database } = await import("@repo/database"));
    upload = await import("../app/api/knowledge/upload/route");
    versionsRoute = await import(
      "../app/api/library/documents/[sourceId]/versions/route"
    );
    fileRoute = await import(
      "../app/api/library/documents/[sourceId]/file/route"
    );
    documents = await import("../lib/knowledge/documents");
    versions = await import("../lib/library/versions");
    processing = await import("../lib/library/process");
    lease = await import("../lib/library/lease");
    stages = await import("../lib/library/stages");
    await database.org.create({ data: { id: otherOrgId, name: "Other" } });
  });

  beforeEach(async () => {
    h.resetState();
    orgId = `org_docs2_${randomUUID().slice(0, 8)}`;
    await database.org.create({
      data: { id: orgId, name: "Docs", ownerUserId: "user_owner" },
    });
    as("planner");
  });

  afterAll(async () => {
    await database?.org.deleteMany({
      where: { id: { startsWith: "org_docs2_" } },
    });
  });

  describe("uploading", () => {
    test("an upload becomes version 1, with its original kept in private storage", async () => {
      const source = await uploaded("Deburr SOP.txt", "Deburr every edge.");
      const [v1] = source.versions;
      expect(source).toMatchObject({
        status: "ready",
        versionSeq: 1,
        currentVersionId: v1.id,
        uploadedBy: "user_planner",
        summary: "About Deburr SOP.",
      });
      expect(v1).toMatchObject({
        number: 1,
        name: "Deburr SOP.txt",
        status: "ready",
        stage: "done",
        originalKept: true,
        mimeType: "text/plain",
        size: 18,
        uploadedBy: "user_planner",
      });
      expect(v1.storageKey).toBe(
        `org/${orgId}/src/${source.id}/v1/${v1.sha256}`
      );
      expect(h.state.store?.objects.has(v1.storageKey as string)).toBe(true);
      expect(await found("deburr")).not.toHaveLength(0);
      const actions = await database.documentAuditLog.findMany({
        where: { orgId, sourceId: source.id },
        orderBy: { createdAt: "asc" },
        select: { action: true, actorId: true },
      });
      expect(actions).toEqual([
        { action: "upload", actorId: "user_planner" },
        { action: "processed", actorId: null },
      ]);
    });

    test("the uploader is the signed-in person, whatever the form says", async () => {
      as("operator", "user_sam");
      const response = await postUpload("Setup.txt", h.text("Setup."), {
        uploadedBy: "user_owner",
        userId: "user_owner",
      });
      expect((await h.events(response)).at(-1)?.type).toBe("done");
      const source = await database.source.findFirstOrThrow({
        where: { orgId, name: "Setup" },
        include: { versions: true },
      });
      expect(source.uploadedBy).toBe("user_sam");
      expect(source.versions[0].uploadedBy).toBe("user_sam");
    });

    test.each([
      ["a text file renamed .pdf", "Plan.pdf", h.text("not a pdf")],
      ["a binary file renamed .txt", "Plan.txt", new Uint8Array([0, 1, 2, 3])],
      ["a PDF renamed .docx", "Plan.docx", h.pdf("x")],
      ["an executable", "Plan.exe", h.text("MZ")],
    ])("%s is refused before anything is stored", async (_, name, bytes) => {
      const response = await postUpload(name, bytes);
      expect(response.status).toBe(400);
      expect(h.state.store?.put).not.toHaveBeenCalled();
      expect(await database.source.count({ where: { orgId } })).toBe(0);
    });

    test("files over 20 MB are refused", async () => {
      const big = new Uint8Array(20 * 1024 * 1024 + 1).fill(65);
      const response = await postUpload("Big.txt", big);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Files can be up to 20 MB.",
      });
    });

    test("the same name never replaces a document, not even for an admin", async () => {
      const original = await uploaded("SOP-12.txt", "Original text.");
      as("admin");
      for (const name of ["SOP-12.txt", "SOP-12.md", "SOP-12.pdf"]) {
        const bytes = name.endsWith(".pdf") ? h.pdf("x") : h.text("New.");
        const response = await postUpload(name, bytes);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error:
            "There's already a document called SOP-12. Rename your file and upload it again.",
          code: "name_taken",
          // The library offers to open it or add a new version (phase 3).
          existing: { id: original.id, name: "SOP-12", canAddVersion: true },
        });
      }
      const after = await database.source.findMany({
        where: { orgId, name: "SOP-12" },
        include: { versions: true },
      });
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(original.id);
      expect(after[0].versions).toHaveLength(1);
      expect(await found("original")).not.toHaveLength(0);
    });

    test("without storage set up, documents are still read but no original is kept", async () => {
      h.state.store = null;
      const source = await uploaded("Quality manual.txt", "Inspect first.");
      expect(source.versions[0]).toMatchObject({
        originalKept: false,
        storageKey: null,
        status: "ready",
      });
      const response = await getFile(source.id);
      expect(response.status).toBe(410);
    });

    test("when storing the original fails, nothing is kept and the person is told", async () => {
      if (h.state.store) {
        h.state.store.fail.put = true;
      }
      const response = await postUpload("Torque.txt", h.text("Torque."));
      expect((await h.events(response)).at(-1)).toEqual({
        type: "error",
        error: "Couldn't save the file just now. Try again in a minute.",
      });
      expect(await database.source.count({ where: { orgId } })).toBe(0);
      expect(await database.storageDeletion.count({ where: { orgId } })).toBe(
        1
      );
    });
  });

  describe("versions", () => {
    test("a new version keeps the document's id and becomes what is searched", async () => {
      const source = await uploaded("Coolant.txt", "Use coolant brand Alpha.");
      const response = await postVersion(
        source.id,
        "Coolant rev B.txt",
        h.text("Use coolant brand Bravo.")
      );
      expect((await h.events(response)).at(-1)?.type).toBe("done");
      const after = await database.source.findUniqueOrThrow({
        where: { id: source.id },
        include: { versions: { orderBy: { number: "asc" } } },
      });
      expect(after.versions.map((v) => [v.number, v.status])).toEqual([
        [1, "ready"],
        [2, "ready"],
      ]);
      expect(after.currentVersionId).toBe(after.versions[1].id);
      expect(after.name).toBe("Coolant");
      expect(await found("bravo")).not.toHaveLength(0);
      expect(await found("alpha")).toHaveLength(0);
      // Version 1's original is still there.
      const old = await getFile(source.id, "?version=1&download=1");
      expect(old.status).toBe(302);
      expect(old.headers.get("location")).toContain("/v1/");
    });

    test("an operator can't add a version; another shop's document isn't found", async () => {
      const source = await uploaded("Fixture.txt", "Fixture A.");
      as("operator");
      expect(
        (await postVersion(source.id, "Fixture.txt", h.text("B."))).status
      ).toBe(403);
      const theirs = await database.source.create({
        data: {
          orgId: otherOrgId,
          name: `Theirs ${randomUUID()}`,
          type: "upload",
          profile: "document",
        },
      });
      as("admin");
      expect(
        (await postVersion(theirs.id, "Theirs.txt", h.text("B."))).status
      ).toBe(404);
    });

    test("simultaneous new versions get distinct numbers", async () => {
      const source = await uploaded("Busy.txt", "v1");
      const made = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          versions.createVersion(orgId, "user_planner", source.id, {
            name: `Busy ${i}.txt`,
            bytes: h.text(`v${i + 2}`),
            mimeType: "text/plain",
          })
        )
      );
      expect(made.map((m) => m?.number).sort()).toEqual([2, 3, 4, 5, 6]);
      const after = await database.source.findUniqueOrThrow({
        where: { id: source.id },
      });
      expect(after.versionSeq).toBe(6);
    });

    test("a failed new version leaves the current one in use and searchable, and can be retried", async () => {
      const source = await uploaded("Spindle.txt", "Warm up spindle Alpha.");
      h.state.embedFailures = 1;
      const response = await postVersion(
        source.id,
        "Spindle.txt",
        h.text("Warm up spindle Bravo.")
      );
      expect((await h.events(response)).at(-1)).toEqual({
        type: "error",
        error:
          "Couldn't read that file just now. Takumo will try again in a few minutes.",
      });
      const v2 = await database.documentVersion.findFirstOrThrow({
        where: { sourceId: source.id, number: 2 },
      });
      expect(v2).toMatchObject({ status: "failed", stage: "embed" });
      expect(v2.nextAttemptAt).not.toBeNull();
      const now = await database.source.findUniqueOrThrow({
        where: { id: source.id },
      });
      expect(now.currentVersionId).toBe(source.versions[0].id);
      expect(await found("alpha")).not.toHaveLength(0);
      expect(await found("bravo")).toHaveLength(0);

      expect(await lease.requeueVersion(orgId, source.id, v2.id)).toBe(true);
      expect((await processing.processVersion(v2.id)).result).toBe("done");
      expect(
        (await database.source.findUniqueOrThrow({ where: { id: source.id } }))
          .currentVersionId
      ).toBe(v2.id);
      expect(await found("bravo")).not.toHaveLength(0);
    });

    test("a version still being processed is never searched", async () => {
      const source = await uploaded("Reamer.txt", "Reamer speed Alpha.");
      const made = await versions.createVersion(
        orgId,
        "user_planner",
        source.id,
        {
          name: "Reamer.txt",
          bytes: h.text("Reamer speed Bravo."),
          mimeType: "text/plain",
        }
      );
      const held = await lease.claimVersion(made?.versionId ?? "");
      if (!held) {
        throw new Error("expected to claim the version");
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
      // Its passages and vectors exist, but it isn't current yet.
      expect(
        await database.docChunk.count({ where: { versionId: held.version.id } })
      ).toBeGreaterThan(0);
      expect(await found("bravo")).toHaveLength(0);
      expect(await found("alpha")).not.toHaveLength(0);
      await lease.releaseLease(held);
      expect((await processing.processVersion(held.version.id)).result).toBe(
        "done"
      );
      expect(await found("bravo")).not.toHaveLength(0);
    });

    test("an older version finishing after a newer one doesn't take over", async () => {
      const source = await uploaded("Drawing notes.txt", "Notes rev one.");
      const file = (body: string) => ({
        name: "Drawing notes.txt",
        bytes: h.text(body),
        mimeType: "text/plain",
      });
      const v2 = await versions.createVersion(
        orgId,
        "user_planner",
        source.id,
        file("Notes rev two.")
      );
      const v3 = await versions.createVersion(
        orgId,
        "user_planner",
        source.id,
        file("Notes rev three.")
      );
      expect(
        (await processing.processVersion(v3?.versionId ?? "")).result
      ).toBe("done");
      expect(
        (await processing.processVersion(v2?.versionId ?? "")).result
      ).toBe("superseded");
      const after = await database.source.findUniqueOrThrow({
        where: { id: source.id },
      });
      expect(after.currentVersionId).toBe(v3?.versionId);
      expect(
        await database.documentVersion.findUniqueOrThrow({
          where: { id: v2?.versionId },
        })
      ).toMatchObject({ status: "superseded", activatedAt: null });
      expect(
        await database.docChunk.count({ where: { versionId: v2?.versionId } })
      ).toBe(0);
      expect(await found("three")).not.toHaveLength(0);
      expect(await found("two")).toHaveLength(0);
    });
  });

  describe("opening and downloading originals", () => {
    test("a member gets a one-minute link, made after the checks and audited", async () => {
      const source = await uploaded("Handbook.txt", "Welcome.");
      as("operator", "user_sam");
      const preview = await getFile(source.id);
      expect(preview.status).toBe(302);
      expect(preview.headers.get("cache-control")).toBe("no-store");
      const link = preview.headers.get("location") ?? "";
      expect(link).toContain(`org/${orgId}/src/${source.id}/v1/`);
      expect(link).toContain("expires=60");
      expect(link).not.toContain("download=");
      const download = await getFile(source.id, "?download=1");
      expect(download.headers.get("location")).toContain(
        "download=Handbook.txt"
      );
      const audits = await database.documentAuditLog.findMany({
        where: { orgId, sourceId: source.id, actorId: "user_sam" },
        orderBy: { createdAt: "asc" },
        select: { action: true },
      });
      expect(audits.map((a) => a.action)).toEqual(["preview", "download"]);
    });

    test("another shop's document, a trashed one and an unknown id are not found", async () => {
      const source = await uploaded("Mine.txt", "Mine.");
      const theirs = await database.source.create({
        data: {
          orgId: otherOrgId,
          name: `Theirs ${randomUUID()}`,
          type: "upload",
          profile: "document",
        },
      });
      expect((await getFile(theirs.id)).status).toBe(404);
      expect((await getFile(randomUUID())).status).toBe(404);
      expect((await getFile(source.id, "?version=7")).status).toBe(404);
      expect((await getFile(source.id, "?version=../x")).status).toBe(400);
      await database.source.update({
        where: { id: source.id },
        data: { deletedAt: new Date() },
      });
      expect((await getFile(source.id)).status).toBe(404);
      expect(h.state.store?.signedUrl).not.toHaveBeenCalled();
    });

    test("someone who isn't a member of the shop gets nothing", async () => {
      const source = await uploaded("Members only.txt", "Hi.");
      h.state.session = { orgId: null, userId: "user_gone", role: null };
      expect((await getFile(source.id)).status).toBe(404);
    });

    test("documents from before originals were kept say so", async () => {
      const legacy = await documents.storeDocument(
        orgId,
        "Old SOP",
        "Old.",
        [{ content: "Old words.", heading: null, page: 1 }],
        { mayReplace: false }
      );
      const response = await getFile(legacy.sourceId);
      expect(response.status).toBe(410);
    });

    test("the preview inside the page is sent by Takumo itself, after the same checks", async () => {
      const drawing = await uploaded("Drawing A102.pdf", "", h.pdf("A102"));
      const notes = await uploaded("Shift notes.txt", "Notes.");
      as("operator", "user_sam");
      const shown = await getFile(drawing.id, "?preview=1");
      expect(shown.status).toBe(200);
      expect(shown.headers.get("content-type")).toBe("application/pdf");
      expect(shown.headers.get("content-disposition")).toMatch(/^inline;/);
      expect(shown.headers.get("x-content-type-options")).toBe("nosniff");
      expect(shown.headers.get("cache-control")).toBe("private, no-store");
      expect(new TextDecoder().decode(await shown.arrayBuffer())).toBe(
        "%PDF-1.7\nA102"
      );
      // Only PDFs and images are shown in the page.
      expect((await getFile(notes.id, "?preview=1")).status).toBe(415);
      const audits = await database.documentAuditLog.findMany({
        where: { orgId, sourceId: drawing.id, actorId: "user_sam" },
        select: { action: true },
      });
      expect(audits.map((a) => a.action)).toEqual(["preview"]);
      expect(h.state.store?.signedUrl).not.toHaveBeenCalled();
    });

    test("previews: large files, other shops, trashed and unkept files are refused", async () => {
      const big = await uploaded("Big scan.pdf", "", h.pdf("Big."));
      await database.documentVersion.updateMany({
        where: { sourceId: big.id },
        data: { size: 4 * 1024 * 1024 + 1 },
      });
      const gone = await uploaded("Gone.pdf", "", h.pdf("Gone."));
      await database.source.update({
        where: { id: gone.id },
        data: { deletedAt: new Date() },
      });
      const reads = h.state.store?.get.mock.calls.length;
      expect((await getFile(big.id, "?preview=1")).status).toBe(413);
      const theirs = await database.source.create({
        data: {
          orgId: otherOrgId,
          name: `Theirs ${randomUUID()}`,
          type: "upload",
          profile: "document",
        },
      });
      expect((await getFile(theirs.id, "?preview=1")).status).toBe(404);
      const legacy = await documents.storeDocument(
        orgId,
        "Old drawing",
        "Old.",
        [{ content: "Old words.", heading: null, page: 1 }],
        { mayReplace: false }
      );
      expect((await getFile(legacy.sourceId, "?preview=1")).status).toBe(410);
      expect((await getFile(gone.id, "?preview=1")).status).toBe(404);
      // Nothing was read from storage for any of them.
      expect(h.state.store?.get.mock.calls.length).toBe(reads);
    });

    test("the database refuses a stored key outside the document's own place", async () => {
      const source = await uploaded("Keyed.txt", "Key.");
      await expect(
        database.documentVersion.update({
          where: { id: source.versions[0].id },
          data: { storageKey: `org/${otherOrgId}/src/${source.id}/v1/x` },
        })
      ).rejects.toThrow();
      await expect(
        database.documentVersion.update({
          where: { id: source.versions[0].id },
          data: { storageKey: `org/${orgId}/src/${source.id}/../../x` },
        })
      ).rejects.toThrow();
    });
  });
});
