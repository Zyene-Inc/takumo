// @vitest-environment node
// Replacing a Knowledge document against a real database. Phase 0 stopped
// people without knowledge:write replacing documents by uploading the same
// name; since the Knowledge Hub's phase 2, uploading never replaces a
// document for anyone (whatever the file's extension, and even when the
// other document arrives while this one is being read): a new version is a
// separate, explicit action (library-documents.db.test.ts). Takumo's own
// sample documents (storeDocument) still replace all-or-nothing. Runs only
// with TEST_DATABASE_URL.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DIMENSIONS = 1024;

vi.mock("server-only", () => ({}));
vi.mock("../../../packages/database/node_modules/server-only", () => ({}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The signed-in person; each test sets the role.
const session = { userId: "user_sam", role: "operator" };
vi.mock("@repo/auth/server", () => ({ auth: async () => session }));
let orgId = "";
vi.mock("../lib/access", () => ({
  authorize: async () => ({ ok: true, orgId }),
}));
vi.mock("../lib/billing", () => ({ featureProblem: async () => null }));

// No AI in tests: embeddings are fixed vectors, reading returns set text.
const embedMany = vi.fn();
vi.mock("@repo/ai", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  embedMany: (...args: unknown[]) => embedMany(...args),
}));
vi.mock("@repo/ai/lib/models", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  canEmbed: true,
  embeddingOptions: () => ({}),
}));
const readDocument = vi.fn();
vi.mock("../lib/knowledge/read", () => ({
  readDocument: (...args: unknown[]) => readDocument(...args),
}));
vi.mock("../lib/knowledge/understand", async (importOriginal) => ({
  ...(await importOriginal<object>()),
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
vi.mock("../lib/facts/notes", () => ({
  shopContext: async () => "",
  extractFacts: async () => [
    {
      subjectType: "part",
      partNo: "P-1001",
      attribute: "setupMin",
      value: "30",
      quote: "Setup takes 30 minutes",
    },
  ],
}));
const proposeFact = vi.fn();
vi.mock("../lib/facts/facts", () => ({
  findSubject: async () => ({
    ok: true,
    subject: { type: "part", id: "p1", label: "P-1001" },
  }),
  proposeFact: (...args: unknown[]) => proposeFact(...args),
}));

type Db = typeof import("@repo/database");
type Documents = typeof import("../lib/knowledge/documents");
type Ingest = typeof import("../lib/knowledge/ingest");
type Route = typeof import("../app/api/knowledge/upload/route");

const vectors = (n: number, dimensions = DIMENSIONS) =>
  Array.from({ length: n }, (_, i) =>
    Array.from({ length: dimensions }, (_, j) => (i + j + 1) / dimensions)
  );

// Real file contents for each type (uploads are checked for them).
const DOCX = new Uint8Array(
  readFileSync(join(import.meta.dirname, "fixtures", "sample.docx"))
);
const bytesFor = (fileName: string, text: string) => {
  const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (ext === ".pdf") {
    return new TextEncoder().encode(`%PDF-1.7\n${text}`);
  }
  return ext === ".docx" ? DOCX : new TextEncoder().encode(text);
};

const upload = (
  fileName: string,
  text = `${fileName} body text`,
  extra: Record<string, string> = {}
) => {
  const form = new FormData();
  form.set("file", new File([bytesFor(fileName, text)], fileName));
  for (const [key, value] of Object.entries(extra)) {
    form.set(key, value);
  }
  return new Request("http://test/api/knowledge/upload", {
    method: "POST",
    body: form,
  });
};

/** Every event the upload streamed. */
const events = async (response: Response) =>
  (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; error?: string });

const chunk = (content: string) => ({ content, heading: null, page: 1 });

describe.skipIf(!TEST_DATABASE_URL)("replacing a document (database)", () => {
  const otherOrgId = `org_replace_other_${randomUUID().slice(0, 8)}`;
  let database: Db["database"];
  let documents: Documents;
  let ingest: Ingest;
  let route: Route;

  /** The shop's documents called `name`, with their passages. */
  const stored = (name: string, org = orgId) =>
    database.source.findMany({
      where: { orgId: org, name, type: "upload", profile: "document" },
      include: { _count: { select: { chunks: true } } },
    });

  const embeddedCount = async (sourceId: string) => {
    const [row] = await database.$queryRawUnsafe<{ n: bigint }[]>(
      `select count(*) as n from "DocChunk" where "sourceId" = $1 and embedding is not null`,
      sourceId
    );
    return Number(row?.n ?? 0);
  };

  /** Store a document as someone allowed to replace it (the starting state). */
  const seed = (name: string, passages = ["Original passage one."]) =>
    documents.storeDocument(orgId, name, "Original.", passages.map(chunk), {
      mayReplace: true,
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SKIP_ENV_VALIDATION = "true";
    ({ database } = await import("@repo/database"));
    documents = await import("../lib/knowledge/documents");
    ingest = await import("../lib/knowledge/ingest");
    route = await import("../app/api/knowledge/upload/route");
    await database.org.create({ data: { id: otherOrgId, name: "Other" } });
  });

  beforeEach(async () => {
    orgId = `org_replace_${randomUUID().slice(0, 8)}`;
    await database.org.create({ data: { id: orgId, name: "Replace test" } });
    session.role = "operator";
    embedMany.mockReset();
    embedMany.mockImplementation(({ values }: { values: string[] }) =>
      Promise.resolve({ embeddings: vectors(values.length) })
    );
    readDocument.mockReset();
    readDocument.mockImplementation((_org: string, name: string) =>
      Promise.resolve({
        pages: [
          { page: 1, text: `New text of ${name}. Setup takes 30 minutes.` },
        ],
        recognized: 0,
      })
    );
    proposeFact.mockReset();
    proposeFact.mockResolvedValue({
      ok: true,
      existing: false,
      fact: { label: "F-1" },
    });
  });

  afterAll(async () => {
    await database?.org.deleteMany({
      where: { id: { startsWith: "org_replace_" } },
    });
  });

  describe("web upload", () => {
    test.each([
      "SOP-12.pdf",
      "SOP-12.PDF",
      "SOP-12.docx",
      "SOP-12.txt",
      "SOP-12.md",
      "SOP-12.csv",
      "[SOP-12].pdf",
    ])("an operator can't replace SOP-12 with %s", async (fileName) => {
      const original = await seed("SOP-12");
      const response = await route.POST(upload(fileName));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error:
          "There's already a document called SOP-12. Rename your file and upload it again.",
        code: "name_taken",
      });
      expect(readDocument).not.toHaveBeenCalled();
      const after = await stored("SOP-12");
      expect(after.map((s) => s.id)).toEqual([original.sourceId]);
      expect(after[0]?._count.chunks).toBe(1);
    });

    test("the request can't grant itself permission to replace", async () => {
      const original = await seed("SOP-12");
      const response = await route.POST(
        upload("SOP-12.pdf", "Overwrite", {
          mayReplace: "true",
          replace: "true",
          role: "admin",
        })
      );
      expect(response.status).toBe(409);
      expect(readDocument).not.toHaveBeenCalled();
      expect((await stored("SOP-12")).map((s) => s.id)).toEqual([
        original.sourceId,
      ]);
    });

    test("an operator can still add a document with a new name", async () => {
      await seed("SOP-12");
      const response = await route.POST(upload("SOP-13.pdf"));
      expect(response.status).toBe(200);
      expect((await events(response)).at(-1)?.type).toBe("done");
      expect(await stored("SOP-13")).toHaveLength(1);
      expect(await stored("SOP-12")).toHaveLength(1);
      expect(proposeFact).toHaveBeenCalledTimes(1);
    });

    test.each([
      "planner",
      "admin",
      "owner",
    ])("a %s can't replace SOP-12 by uploading SOP-12.docx either", async (role) => {
      session.role = role;
      const original = await seed("SOP-12");
      const response = await route.POST(upload("SOP-12.docx"));
      expect(response.status).toBe(409);
      expect(readDocument).not.toHaveBeenCalled();
      const after = await stored("SOP-12");
      expect(after.map((s) => s.id)).toEqual([original.sourceId]);
      expect(after[0]?.summary).toBe("Original.");
      expect(after[0]?._count.chunks).toBe(1);
      expect(proposeFact).not.toHaveBeenCalled();
    });

    test("while an upload is being read, its name is taken: nothing else can store it", async () => {
      const raced: unknown[] = [];
      readDocument.mockImplementation(async (_org: string, name: string) => {
        // Someone else tries to store the same name meanwhile.
        raced.push(
          await documents
            .storeDocument(orgId, "Late SOP", "Theirs.", [chunk("Theirs.")], {
              mayReplace: false,
            })
            .catch((e: unknown) => e)
        );
        return { pages: [{ page: 1, text: `Text of ${name}` }], recognized: 0 };
      });
      const response = await route.POST(upload("Late SOP.pdf"));
      expect((await events(response)).at(-1)?.type).toBe("done");
      expect(raced[0]).toBeInstanceOf(documents.DocumentExistsError);
      const after = await stored("Late SOP");
      expect(after).toHaveLength(1);
      expect(after[0]?.summary).toBe("About Late SOP.");
    });
  });

  describe("storeDocument", () => {
    test("refuses to replace without permission and changes nothing", async () => {
      const original = await seed("Torque chart", ["One.", "Two."]);
      await expect(
        documents.storeDocument(orgId, "Torque chart", "New.", [chunk("x")], {
          mayReplace: false,
        })
      ).rejects.toBeInstanceOf(documents.DocumentExistsError);
      const after = await stored("Torque chart");
      expect(after.map((s) => s.id)).toEqual([original.sourceId]);
      expect(after[0]?._count.chunks).toBe(2);
      expect(await embeddedCount(original.sourceId)).toBe(2);
    });

    test("a failed write keeps the previous document whole", async () => {
      const original = await seed("Deburr SOP", ["One.", "Two."]);
      // Postgres rejects a NUL character in text: the passages fail to save
      // after the old document was already deleted inside the transaction.
      await expect(
        documents.storeDocument(
          orgId,
          "Deburr SOP",
          "New.",
          [chunk("Fine."), chunk("Broken \u0000 passage.")],
          { mayReplace: true }
        )
      ).rejects.toThrow();
      const after = await stored("Deburr SOP");
      expect(after.map((s) => s.id)).toEqual([original.sourceId]);
      expect(after[0]?.summary).toBe("Original.");
      expect(after[0]?._count.chunks).toBe(2);
      expect(await embeddedCount(original.sourceId)).toBe(2);
      expect(
        await database.docChunk.count({ where: { content: "Fine." } })
      ).toBe(0);
    });

    test("a failure on the last step (the vectors) also rolls back", async () => {
      const original = await seed("Coolant SOP");
      embedMany.mockResolvedValueOnce({ embeddings: vectors(1, 3) });
      await expect(
        documents.storeDocument(orgId, "Coolant SOP", "New.", [chunk("New.")], {
          mayReplace: true,
        })
      ).rejects.toThrow();
      const after = await stored("Coolant SOP");
      expect(after.map((s) => s.id)).toEqual([original.sourceId]);
      expect(
        await database.docChunk.count({ where: { content: "New." } })
      ).toBe(0);
    });

    test("when embedding fails the document is still stored for keywords", async () => {
      embedMany.mockRejectedValueOnce(new Error("provider down"));
      const result = await documents.storeDocument(
        orgId,
        "Keyword only",
        "Summary.",
        [chunk("Some words.")],
        { mayReplace: false }
      );
      expect(result.embedded).toBe(false);
      expect(await stored("Keyword only")).toHaveLength(1);
      expect(await embeddedCount(result.sourceId)).toBe(0);
    });

    test("replacing leaves other shops and other kinds of source alone", async () => {
      await seed("Shared name");
      await database.source.create({
        data: { orgId, name: "Shared name", type: "upload", profile: "parts" },
      });
      await database.source.create({
        data: {
          orgId: otherOrgId,
          name: "Shared name",
          type: "upload",
          profile: "document",
        },
      });
      await documents.storeDocument(
        orgId,
        "Shared name",
        "New.",
        [chunk("New.")],
        { mayReplace: true }
      );
      expect(await stored("Shared name")).toHaveLength(1);
      expect(await stored("Shared name", otherOrgId)).toHaveLength(1);
      expect(
        await database.source.count({
          where: { orgId, name: "Shared name", profile: "parts" },
        })
      ).toBe(1);
    });

    test("two uploads of a new name at once: one is stored, one refused", async () => {
      const results = await Promise.allSettled(
        ["First", "Second"].map((who) =>
          documents.storeDocument(orgId, "Race", who, [chunk(who)], {
            mayReplace: false,
          })
        )
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const refused = results.find((r) => r.status === "rejected");
      expect(refused?.status === "rejected" && refused.reason).toBeInstanceOf(
        documents.DocumentExistsError
      );
      expect(await stored("Race")).toHaveLength(1);
    });

    test("two replacements at once leave exactly one document", async () => {
      await seed("Busy SOP");
      await Promise.all(
        ["A", "B", "C"].map((who) =>
          documents.storeDocument(orgId, "Busy SOP", who, [chunk(who)], {
            mayReplace: true,
          })
        )
      );
      const after = await stored("Busy SOP");
      expect(after).toHaveLength(1);
      expect(after[0]?._count.chunks).toBe(1);
    });
  });

  describe("ingestDocument", () => {
    // The lock and the lookup both use the cleaned name, so files that
    // differ only by extension contend for the same document.
    const ingestAtOnce = (fileNames: string[]) =>
      Promise.allSettled(
        fileNames.map((name) =>
          ingest.ingestDocument(
            orgId,
            "user_sam",
            { name, bytes: bytesFor(name, "Plan") },
            () => undefined,
            { via: "upload" }
          )
        )
      );

    test("Plan.pdf and Plan.docx at once: one is stored", async () => {
      const results = await ingestAtOnce(["Plan.pdf", "Plan.docx"]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const refused = results.find((r) => r.status === "rejected");
      expect(refused?.status === "rejected" && refused.reason).toBeInstanceOf(
        documents.DocumentExistsError
      );
      expect(await stored("Plan")).toHaveLength(1);
    });

    test("Plan.pdf, Plan.PDF and Plan.md at once never replace Plan", async () => {
      const original = await seed("Plan");
      const results = await ingestAtOnce(["Plan.pdf", "Plan.PDF", "Plan.md"]);
      expect(results.every((r) => r.status === "rejected")).toBe(true);
      const after = await stored("Plan");
      expect(after.map((s) => s.id)).toEqual([original.sourceId]);
      expect(after[0]?.summary).toBe("Original.");
    });

    test("no facts are proposed for a refused document", async () => {
      await seed("Setup P-1001");
      const emitted: { type: string }[] = [];
      await expect(
        ingest.ingestDocument(
          orgId,
          "user_sam",
          { name: "Setup P-1001.docx", bytes: DOCX },
          (e) => emitted.push(e),
          { via: "upload" }
        )
      ).rejects.toBeInstanceOf(documents.DocumentExistsError);
      expect(emitted.some((e) => e.type === "done")).toBe(false);
      expect(proposeFact).not.toHaveBeenCalled();
      expect((await stored("Setup P-1001"))[0]?.summary).toBe("Original.");
    });

    test("documentNamed finds a document by any supported extension", async () => {
      await seed("Fixture plan");
      for (const fileName of ["Fixture plan.pdf", "Fixture plan.CSV"]) {
        expect(await documents.documentNamed(orgId, fileName)).toMatchObject({
          name: "Fixture plan",
        });
      }
      // Images keep their extension in the stored name, so they're a
      // different document and never replace this one.
      expect(await documents.documentNamed(orgId, "Fixture plan.png")).toBe(
        null
      );
    });
  });
});
