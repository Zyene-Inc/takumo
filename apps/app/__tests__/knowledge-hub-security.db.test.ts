// @vitest-environment node
// This file: access, grants and moves. Ask's tools, facts, the Trash and
// conversation history are in knowledge-hub-security-ai.db.test.ts (same setup).
// Knowledge Hub phase 4, against a real database: who may open what, and
// that every AI path (document search, agent tools, the SQL reader, facts,
// the Brain's inputs, conversation history) only ever reads what the person
// asking may use. Two shops: A (owner, admin, HR, engineering, finance, an
// operator, someone in two departments, a former employee) and B (owner,
// admin). Documents carry distinguishable text, so a leak shows as a word.
// Restricted access is switched off in code; these tests switch it on to
// check the rules behind it. Runs only with TEST_DATABASE_URL (and the SQL
// reader parts with TEST_ASK_DATABASE_URL).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const READER = process.env.TEST_ASK_DATABASE_URL;
process.env.ASK_DATABASE_URL = READER;
// The SQL tool is off unless switched on (Ask SQL hotfix); these tests check
// what it may read once it is.
process.env.ASK_SQL_ENABLED = "true";
process.env.SKIP_ENV_VALIDATION = "true";

vi.mock("server-only", () => ({}));
vi.mock("../../../packages/database/node_modules/server-only", () => ({}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../lib/analytics", () => ({ track: vi.fn() }));

// Active WorkOS memberships, "shop:user" → role (WorkOS is mocked).
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
const stage = { enabled: true };
vi.mock("../lib/library/stage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confidentialEnabled: async () => stage.enabled,
}));

// Vectors: every passage and every question get the same one, so vector
// search would return every passage it's allowed to read.
const DIMENSIONS = 1024;
const VECTOR = Array.from({ length: DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));
const embedCalls: string[] = [];
vi.mock("@repo/ai", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  embed: async ({ value }: { value: string }) => {
    embedCalls.push(value);
    return { embedding: VECTOR };
  },
}));
vi.mock("@repo/ai/lib/models", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  canEmbed: true,
  embeddingOptions: () => ({}),
}));

type Db = typeof import("@repo/database");
type Viewer = import("../lib/library/viewer").Viewer;

const id = () => randomUUID();
const ALL = 63;
const EDITOR = 31;
const VIEWER = 3;
/** Manage, view and download: nothing else. */
const MANAGE_AND_VIEW = 35;

// Words that only appear in one document each.
const WORD = {
  hr: "zebrasalary",
  eng: "quokkatorque",
  fin: "narwhalbudget",
  pub: "pangolindeburr",
  shared: "okapiwarmup",
  b: "axolotlsecret",
};

describe.skipIf(!TEST_DATABASE_URL)("knowledge hub security (database)", () => {
  const A = `org_sec_a_${id().slice(0, 8)}`;
  const B = `org_sec_b_${id().slice(0, 8)}`;
  let database: Db["database"];
  let viewers: typeof import("../lib/library/viewer");
  let access: typeof import("../lib/library/access");
  let documents: typeof import("../lib/knowledge/documents");
  let grants: typeof import("../lib/library/grants");
  let departments: typeof import("../lib/library/departments");
  let folders: typeof import("../lib/library/folders");
  let lifecycle: typeof import("../lib/library/lifecycle");
  let download: typeof import("../lib/library/download");
  let tools: typeof import("../lib/agent/tools");

  const dept = { hr: id(), eng: id(), fin: id() };
  const folder = { general: id(), eng: id(), hr: id(), fin: id() };
  const doc = { pub: "", eng: "", hr: "", fin: "", shared: "", b: "" };

  const as = async (orgId: string, userId: string): Promise<Viewer> => {
    const viewer = await viewers.viewerForMember(orgId, userId);
    if (!viewer) {
      throw new Error(`${userId} isn't a member of ${orgId}`);
    }
    return viewer;
  };

  /** A document with one passage, current and searchable (no pipeline). */
  const addDoc = async (
    orgId: string,
    name: string,
    folderId: string | null,
    body: string
  ) => {
    const sourceId = id();
    const versionId = id();
    await database.source.create({
      data: {
        id: sourceId,
        orgId,
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
        orgId,
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
    await database.docChunk.createMany({
      data: [
        {
          orgId,
          sourceId,
          versionId,
          ordinal: 0,
          content: `${name}: about it.`,
          meta: { kind: "card", docType: "sop", links: [] },
        },
        {
          orgId,
          sourceId,
          versionId,
          ordinal: 1,
          content: body,
          page: 1,
          meta: {},
        },
      ],
    });
    await database.$executeRawUnsafe(
      `update "DocChunk" set embedding = $1::vector where "sourceId" = $2`,
      `[${VECTOR.join(",")}]`,
      sourceId
    );
    return sourceId;
  };

  /**
   * The asked-for words of WORD that Ask's document search finds for this
   * viewer (every passage shares one vector, so vector search returns all
   * the passages they may use: only the asked words count).
   */
  const askFinds = async (
    viewer: Viewer,
    query = Object.values(WORD).join(" ")
  ) => {
    const hits = await documents.searchDocuments(viewer, query, 50);
    const text = hits.map((h) => h.snippet).join(" ");
    return Object.entries(WORD)
      .filter(([, word]) => query.includes(word) && text.includes(word))
      .map(([key]) => key)
      .sort();
  };

  /** A fact read from these documents (provenance "documents"). */

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    ({ database } = await import("@repo/database"));
    viewers = await import("../lib/library/viewer");
    access = await import("../lib/library/access");
    documents = await import("../lib/knowledge/documents");
    grants = await import("../lib/library/grants");
    departments = await import("../lib/library/departments");
    folders = await import("../lib/library/folders");
    lifecycle = await import("../lib/library/lifecycle");
    download = await import("../lib/library/download");
    tools = await import("../lib/agent/tools");

    for (const [user, role] of [
      ["user_owner", "admin"],
      ["user_admin", "admin"],
      ["user_hr", "member"],
      ["user_eng", "planner"],
      ["user_fin", "member"],
      ["user_op", "operator"],
      ["user_multi", "member"],
      // user_former is in HR's department but no longer in the shop.
    ]) {
      members.set(`${A}:${user}`, role);
    }
    members.set(`${B}:user_b_owner`, "admin");
    members.set(`${B}:user_b_admin`, "admin");

    for (const [orgId, owner] of [
      [A, "user_owner"],
      [B, "user_b_owner"],
    ]) {
      await database.org.create({
        data: {
          id: orgId,
          name: orgId,
          ownerUserId: owner,
          libraryStage: "confidential",
        },
      });
    }
    await database.department.createMany({
      data: [
        { id: dept.hr, orgId: A, name: "Human Resources" },
        { id: dept.eng, orgId: A, name: "Engineering" },
        { id: dept.fin, orgId: A, name: "Finance" },
      ],
    });
    await database.departmentMember.createMany({
      data: [
        { orgId: A, departmentId: dept.hr, userId: "user_hr" },
        { orgId: A, departmentId: dept.hr, userId: "user_former" },
        { orgId: A, departmentId: dept.eng, userId: "user_eng" },
        { orgId: A, departmentId: dept.fin, userId: "user_fin" },
        { orgId: A, departmentId: dept.eng, userId: "user_multi" },
        { orgId: A, departmentId: dept.fin, userId: "user_multi" },
      ],
    });
    await database.folder.createMany({
      data: [
        { id: folder.general, orgId: A, name: "General" },
        // Restricted (doesn't inherit) but not confidential: admins still see it.
        { id: folder.eng, orgId: A, name: "Engineering", inheritAccess: false },
        {
          id: folder.hr,
          orgId: A,
          name: "HR",
          confidential: true,
          inheritAccess: false,
        },
        {
          id: folder.fin,
          orgId: A,
          name: "Finance",
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
          folderId: folder.eng,
          principalType: "department",
          principalId: dept.eng,
          capabilities: EDITOR,
        },
        {
          orgId: A,
          folderId: folder.hr,
          principalType: "department",
          principalId: dept.hr,
          capabilities: EDITOR,
        },
        // A grant to everyone in a confidential folder only lets them upload.
        {
          orgId: A,
          folderId: folder.hr,
          principalType: "everyone",
          capabilities: VIEWER,
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
    doc.pub = await addDoc(
      A,
      "Deburring SOP",
      folder.general,
      `Deburr edges: ${WORD.pub}.`
    );
    doc.eng = await addDoc(
      A,
      "Spindle spec",
      folder.eng,
      `Spindle torque ${WORD.eng} Nm.`
    );
    doc.hr = await addDoc(
      A,
      "Payroll 2026",
      folder.hr,
      `Employee salary ${WORD.hr} $95,000.`
    );
    doc.fin = await addDoc(
      A,
      "Budget",
      folder.fin,
      `Annual budget ${WORD.fin}.`
    );
    doc.shared = await addDoc(
      A,
      "Warm-up",
      folder.general,
      `Spindle warm-up ${WORD.shared} 10 minutes.`
    );
    doc.b = await addDoc(B, "B secret", null, `Shop B only ${WORD.b}.`);
  });

  afterAll(async () => {
    await database.org.deleteMany({ where: { id: { in: [A, B] } } });
  });

  describe("who can open what", () => {
    test("each person's questions only reach the documents they may open", async () => {
      expect(await askFinds(await as(A, "user_eng"))).toEqual([
        "eng",
        "pub",
        "shared",
      ]);
      expect(await askFinds(await as(A, "user_hr"))).toEqual([
        "hr",
        "pub",
        "shared",
      ]);
      expect(await askFinds(await as(A, "user_fin"))).toEqual([
        "fin",
        "pub",
        "shared",
      ]);
      expect(await askFinds(await as(A, "user_multi"))).toEqual([
        "eng",
        "fin",
        "pub",
        "shared",
      ]);
      // The owner opens everything; an admin everything but confidential folders.
      expect(await askFinds(await as(A, "user_owner"))).toEqual([
        "eng",
        "fin",
        "hr",
        "pub",
        "shared",
      ]);
      expect(await askFinds(await as(A, "user_admin"))).toEqual([
        "eng",
        "pub",
        "shared",
      ]);
      expect(await askFinds(await as(A, "user_op"))).toEqual(["pub", "shared"]);
      // Background work sees what everyone may.
      expect(await askFinds(viewers.systemViewer(A))).toEqual([
        "pub",
        "shared",
      ]);
      // Nothing from the other shop, ever.
      expect(await askFinds(await as(B, "user_b_owner"))).toEqual(["b"]);
    });

    test("vector search is filtered in the query too", async () => {
      // Every passage has the question's vector: vector search alone would
      // return all of them. The HR word isn't in the question at all.
      const hits = await documents.searchDocuments(
        await as(A, "user_eng"),
        "anything",
        50
      );
      const ids = new Set(hits.map((h) => h.sourceId));
      expect(ids.has(doc.hr)).toBe(false);
      expect(ids.has(doc.fin)).toBe(false);
      expect(ids.has(doc.b)).toBe(false);
      expect(ids.has(doc.eng)).toBe(true);
    });

    test("the library's own search, listing and file routes follow the same access", async () => {
      const eng = await as(A, "user_eng");
      const passages = await documents.keywordPassages(eng, WORD.hr, 20);
      expect(passages).toEqual([]);
      expect(await access.accessTo(eng, { sourceId: doc.hr })).toMatchObject({
        capabilities: 0,
      });
      for (const request of [
        { download: false },
        { download: true },
        { download: true, version: 1 },
      ]) {
        expect(await download.fileLink(eng, doc.hr, request)).toMatchObject({
          ok: false,
          status: 404,
        });
      }
      expect(await download.previewFile(eng, doc.hr)).toMatchObject({
        ok: false,
        status: 404,
      });
      // Another shop's ids are simply not there.
      const other = await as(B, "user_b_owner");
      expect(await access.accessTo(other, { sourceId: doc.pub })).toBeNull();
      expect(
        await download.fileLink(other, doc.pub, { download: true })
      ).toMatchObject({
        ok: false,
        status: 404,
      });
    });

    test("a former employee and forged viewers get nothing", async () => {
      expect(await viewers.viewerForMember(A, "user_former")).toBeNull();
      const forged = {
        orgId: A,
        userId: "user_owner",
        role: "admin",
        isOwner: true,
        isAdmin: true,
        isSystem: false,
      };
      await expect(
        documents.searchDocuments(forged as Viewer, WORD.hr)
      ).rejects.toThrow("viewer made on the server");
      expect(() => tools.agentContext(forged as Viewer, "2026-11-07")).toThrow(
        "viewer made on the server"
      );
      // A context whose shop or user doesn't match its viewer is refused.
      const eng = await as(A, "user_eng");
      expect(() =>
        tools.createTools({
          ...tools.agentContext(eng, "2026-11-07"),
          userId: "user_owner",
        })
      ).toThrow("doesn't match");
      expect(() =>
        tools.createTools({
          ...tools.agentContext(eng, "2026-11-07"),
          orgId: B,
        })
      ).toThrow("doesn't match");
    });

    test("department changes take effect on the next request", async () => {
      const owner = await as(A, "user_owner");
      const eng = await as(A, "user_eng");
      expect(await askFinds(eng, WORD.hr)).toEqual([]);
      expect(
        await departments.addDepartmentMember(owner, dept.hr, "user_eng")
      ).toEqual({ ok: true });
      expect(await askFinds(eng, WORD.hr)).toEqual(["hr"]);
      expect(
        await departments.removeDepartmentMember(owner, dept.hr, "user_eng")
      ).toEqual({ ok: true });
      expect(await askFinds(eng, WORD.hr)).toEqual([]);
    });

    test("an admin can't reach HR by changing departments, grants or the confidential flag", async () => {
      const admin = await as(A, "user_admin");
      expect(
        await departments.addDepartmentMember(admin, dept.hr, "user_admin")
      ).toMatchObject({ ok: false });
      expect(
        await departments.renameDepartment(admin, dept.hr, "Old HR")
      ).toMatchObject({ ok: false });
      expect(await departments.deleteDepartment(admin, dept.hr)).toMatchObject({
        ok: false,
      });
      expect(
        await grants.grantAccess(
          admin,
          { folderId: folder.hr },
          { type: "user", id: "user_admin" },
          VIEWER
        )
      ).toMatchObject({ ok: false });
      expect(
        await grants.setConfidential(admin, folder.hr, false)
      ).toMatchObject({ ok: false });
      // A new department with the admin in it opens nothing in HR either.
      const made = await departments.createDepartment(admin, "Admins club");
      if (!made.ok) {
        throw new Error(made.error);
      }
      await departments.addDepartmentMember(admin, made.id, "user_admin");
      expect(
        await grants.grantAccess(
          admin,
          { folderId: folder.hr },
          { type: "department", id: made.id },
          VIEWER
        )
      ).toMatchObject({ ok: false });
      expect(await askFinds(await as(A, "user_admin"), WORD.hr)).toEqual([]);
      expect(
        await database.departmentMember.count({
          where: { orgId: A, departmentId: dept.hr, userId: "user_admin" },
        })
      ).toBe(0);
    });

    test("a manager can't hand out more than they hold, and nobody can lock out the owner", async () => {
      const owner = await as(A, "user_owner");
      // user_fin may view and manage one HR document, nothing more.
      const memo = await addDoc(A, "HR memo", folder.hr, "Memo.");
      await grants.grantAccess(
        owner,
        { sourceId: memo },
        { type: "user", id: "user_fin" },
        MANAGE_AND_VIEW
      );
      const fin = await as(A, "user_fin");
      expect(
        await grants.grantAccess(
          fin,
          { sourceId: memo },
          { type: "user", id: "user_op" },
          ALL
        )
      ).toEqual({
        ok: false,
        error: "You can only give access you have yourself.",
      });
      // Everyone or a role may only upload in a confidential folder.
      expect(
        await grants.grantAccess(
          fin,
          { sourceId: memo },
          { type: "everyone" },
          VIEWER
        )
      ).toMatchObject({ ok: false });
      // What they hold, they may pass on.
      expect(
        await grants.grantAccess(
          fin,
          { sourceId: memo },
          { type: "user", id: "user_op" },
          VIEWER
        )
      ).toEqual({ ok: true });
      // Taking every grant away still leaves the owner in full control.
      for (const g of await database.accessGrant.findMany({
        where: { orgId: A, sourceId: memo },
      })) {
        await grants.revokeAccess(owner, g.id);
      }
      expect(
        (await access.accessTo(owner, { sourceId: memo }))?.capabilities
      ).toBe(ALL);
      await lifecycle.purgeSource(A, memo, "user_owner");
    });

    test("a document-level grant opens that document only", async () => {
      const owner = await as(A, "user_owner");
      const extra = await addDoc(
        A,
        "Engineering salary band",
        folder.hr,
        `Band ${WORD.hr}-eng`
      );
      expect(
        await grants.grantAccess(
          owner,
          { sourceId: extra },
          { type: "user", id: "user_eng" },
          VIEWER
        )
      ).toEqual({ ok: true });
      const eng = await as(A, "user_eng");
      try {
        const found = await documents.searchDocuments(eng, WORD.hr, 50);
        expect(
          new Set(
            found
              .filter((h) => h.snippet.includes(WORD.hr))
              .map((h) => h.sourceId)
          )
        ).toEqual(new Set([extra]));
      } finally {
        await lifecycle.purgeSource(A, extra, "user_owner");
      }
    });

    test("a document that stops inheriting keeps exactly who had access; resuming asks first", async () => {
      const owner = await as(A, "user_owner");
      const shut = await addDoc(A, "Shut", folder.general, "Shut away.");
      expect(
        await grants.setInheritance(owner, { sourceId: shut }, false)
      ).toEqual({ ok: true });
      const op = await as(A, "user_op");
      expect(await access.accessTo(op, { sourceId: shut })).toMatchObject({
        capabilities: 7,
      });
      // Remove the copied grant: now only the owner and admins.
      const [copied] = await database.accessGrant.findMany({
        where: { orgId: A, sourceId: shut },
      });
      await grants.revokeAccess(owner, copied.id);
      expect(
        (await access.accessTo(op, { sourceId: shut }))?.capabilities
      ).toBe(0);
      // Resuming would let everyone back in: it has to be confirmed.
      const asked = await grants.setInheritance(
        owner,
        { sourceId: shut },
        true
      );
      expect(asked).toMatchObject({ ok: false, confirm: [expect.anything()] });
      expect(
        await grants.setInheritance(owner, { sourceId: shut }, true, {
          confirmed: true,
        })
      ).toEqual({ ok: true });
      expect(
        (await access.accessTo(op, { sourceId: shut }))?.capabilities
      ).toBe(7);
      await lifecycle.purgeSource(A, shut, "user_owner");
    });
  });

  describe("moving never widens access", () => {
    test("into a folder with other access, a document keeps who could open it", async () => {
      const owner = await as(A, "user_owner");
      const moving = await addDoc(
        A,
        "Moving",
        folder.eng,
        `Moving ${WORD.eng}-m`
      );
      const op = await as(A, "user_op");
      expect(
        (await access.accessTo(op, { sourceId: moving }))?.capabilities
      ).toBe(0);
      expect(await folders.moveDocument(owner, moving, folder.general)).toEqual(
        { ok: true }
      );
      // Still only Engineering (and the owner and admins): not everyone.
      expect(
        (await access.accessTo(op, { sourceId: moving }))?.capabilities
      ).toBe(0);
      expect(
        (await access.accessTo(await as(A, "user_eng"), { sourceId: moving }))
          ?.capabilities
      ).toBe(EDITOR);
      // "Use the destination's access" is a deliberate choice that needs manage.
      const moved = await database.source.findUniqueOrThrow({
        where: { id: moving },
      });
      expect(moved.inheritAccess).toBe(false);
      await lifecycle.purgeSource(A, moving, "user_owner");
    });

    test("out of a confidential folder needs the owner; into one only narrows", async () => {
      const owner = await as(A, "user_owner");
      const hr = await as(A, "user_hr");
      const leaving = await addDoc(
        A,
        "Leaving",
        folder.hr,
        `Leaving ${WORD.hr}-x`
      );
      // The HR member may edit it and add to General, but not take it out.
      expect(
        await folders.moveDocument(hr, leaving, folder.general)
      ).toMatchObject({ ok: false, status: 403 });
      expect(
        (await database.source.findUniqueOrThrow({ where: { id: leaving } }))
          .folderId
      ).toBe(folder.hr);
      // Into HR from General: everyone's view is cut back to uploading.
      const arriving = await addDoc(A, "Arriving", folder.general, "Arriving.");
      expect(await folders.moveDocument(owner, arriving, folder.hr)).toEqual({
        ok: true,
      });
      const op = await as(A, "user_op");
      expect(
        (await access.accessTo(op, { sourceId: arriving }))?.capabilities
      ).toBe(4);
      // An admin loses automatic access inside a confidential folder.
      expect(
        (
          await access.accessTo(await as(A, "user_admin"), {
            sourceId: arriving,
          })
        )?.capabilities
      ).toBe(4);
      await lifecycle.purgeSource(A, leaving, "user_owner");
      await lifecycle.purgeSource(A, arriving, "user_owner");
    });

    test("a folder from HR's Trash can't land at the top level", async () => {
      const owner = await as(A, "user_owner");
      const sub = await folders.createFolder(owner, folder.hr, "Old reviews");
      if (!sub.ok) {
        throw new Error(sub.error);
      }
      const old = await addDoc(A, "Review", sub.id, "Old review.");
      await lifecycle.trashDocument(owner, old);
      expect(await folders.deleteFolder(owner, sub.id)).toMatchObject({
        ok: false,
        status: 409,
      });
      await lifecycle.purgeSource(A, old, "user_owner");
      expect(await folders.deleteFolder(owner, sub.id)).toEqual({ ok: true });
    });
  });
});
