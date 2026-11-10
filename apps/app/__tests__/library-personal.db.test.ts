// @vitest-environment node
// Personal and Public folders (database). A personal folder is its person's
// alone: not the shop's owner, not admins, not a grant, not Ask Takumo for
// anyone else, not the roles that edit documents while a shop restricts
// nothing. Each test below is a way someone else might reach one.
// Needs TEST_DATABASE_URL.
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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/library/handoff", () => ({ scheduleHandOff: vi.fn() }));

const members = new Map<string, string>();
vi.mock("@repo/auth/server", () => ({
  auth: async () => ({ userId: null, orgId: null, role: null }),
  shopRole: async (userId: string, orgId: string) =>
    members.get(`${orgId}:${userId}`) ?? null,
  listShopMembers: async () => [],
}));
// Whether the shop restricts access: some checks differ (guard.ts).
const stage = vi.hoisted(() => ({ restricting: true }));
vi.mock("../lib/library/stage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confidentialEnabled: async () => stage.restricting,
  restrictedAccessReady: () => true,
}));
const store = vi.hoisted(() => ({
  put: () => Promise.resolve(),
  get: () => Promise.resolve(new Uint8Array([1, 2, 3])),
  remove: vi.fn(() => Promise.resolve()),
  signedUrl: (key: string) => Promise.resolve(`https://storage.test/${key}`),
}));
vi.mock("../lib/library/storage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  objectStore: () => store,
}));

type Db = typeof import("@repo/database");
type Viewer = import("../lib/library/viewer").Viewer;

const id = () => randomUUID();
const ALL = 63;

describe.skipIf(!TEST_DATABASE_URL)("personal and public folders", () => {
  const orgId = `org_pers_${id().slice(0, 8)}`;
  let database: Db["database"];
  let viewers: typeof import("../lib/library/viewer");
  let access: typeof import("../lib/library/access");
  let ai: typeof import("../lib/library/ai-access");
  let guard: typeof import("../lib/library/guard");
  let personal: typeof import("../lib/library/personal");
  let folders: typeof import("../lib/library/folders");
  let moves: typeof import("../lib/library/folder-moves");
  let grants: typeof import("../lib/library/grants");
  let lifecycle: typeof import("../lib/library/lifecycle");
  let sweep: typeof import("../lib/library/personal-sweep");
  let alicesFolder = "";
  const doc = { secret: id(), shared: id(), bobs: id(), deep: id() };

  const as = async (userId: string): Promise<Viewer> => {
    const v = await viewers.viewerForMember(orgId, userId);
    if (!v) {
      throw new Error(`${userId} isn't a member`);
    }
    return v;
  };

  const addDoc = async (
    sourceId: string,
    name: string,
    folderId: string,
    uploadedBy: string
  ) => {
    await database.source.create({
      data: {
        id: sourceId,
        orgId,
        name,
        type: "upload",
        profile: "document",
        folderId,
        uploadedBy,
        status: "ready",
        summary: `Summary of ${name}.`,
      },
    });
    const versionId = id();
    await database.documentVersion.create({
      data: {
        id: versionId,
        orgId,
        sourceId,
        number: 1,
        name: `${name}.pdf`,
        status: "ready",
        originalKept: true,
        storageKey: `org/${orgId}/src/${sourceId}/v1.pdf`,
        mimeType: "application/pdf",
        size: 3,
        uploadedBy,
      },
    });
    await database.source.update({
      where: { id: sourceId },
      data: { currentVersionId: versionId, versionSeq: 1 },
    });
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    ({ database } = await import("@repo/database"));
    viewers = await import("../lib/library/viewer");
    access = await import("../lib/library/access");
    ai = await import("../lib/library/ai-access");
    guard = await import("../lib/library/guard");
    personal = await import("../lib/library/personal");
    folders = await import("../lib/library/folders");
    moves = await import("../lib/library/folder-moves");
    grants = await import("../lib/library/grants");
    lifecycle = await import("../lib/library/lifecycle");
    sweep = await import("../lib/library/personal-sweep");
    members.set(`${orgId}:u_owner`, "admin");
    members.set(`${orgId}:u_admin`, "admin");
    members.set(`${orgId}:u_alice`, "operator");
    members.set(`${orgId}:u_bob`, "planner");
    await database.org.create({
      data: {
        id: orgId,
        name: "Personal test",
        ownerUserId: "u_owner",
        libraryStage: "confidential",
      },
    });
    await personal.ensurePersonalFolder(await as("u_alice"));
    const folder = await database.folder.findFirstOrThrow({
      where: { orgId, personalUserId: "u_alice" },
    });
    alicesFolder = folder.id;
    const publicId = (await folders.publicFolderId(orgId)) as string;
    await addDoc(
      doc.secret,
      "Job offer from a competitor",
      alicesFolder,
      "u_alice"
    );
    await addDoc(doc.shared, "Alice's setup notes", publicId, "u_alice");
    await addDoc(doc.bobs, "Bob's fixture drawing", publicId, "u_bob");
  });

  afterAll(async () => {
    await database.folder.updateMany({
      where: { orgId },
      data: { parentId: null },
    });
    await database.org.deleteMany({ where: { id: orgId } });
  });

  describe("only its person", () => {
    test("Alice can do everything with her folder and what's in it", async () => {
      const alice = await as("u_alice");
      expect((await access.folderCapabilities(alice)).get(alicesFolder)).toBe(
        ALL
      );
      expect((await access.documentCapabilities(alice)).get(doc.secret)).toBe(
        ALL
      );
      expect(
        (await guard.authorizeDocument(alice, doc.secret, "view")).ok
      ).toBe(true);
    });

    test.each([
      ["the owner", "u_owner"],
      ["an admin", "u_admin"],
      ["another member", "u_bob"],
    ])("%s can't see it, open it or learn it exists", async (_who, userId) => {
      const viewer = await as(userId);
      expect((await access.folderCapabilities(viewer)).get(alicesFolder)).toBe(
        0
      );
      expect((await access.documentCapabilities(viewer)).get(doc.secret)).toBe(
        0
      );
      expect(await access.visibleSourceIds(viewer)).not.toContain(doc.secret);
      // Not "forbidden": not found, so an id tells them nothing.
      const opened = await guard.authorizeDocument(viewer, doc.secret, "view");
      expect(opened).toMatchObject({ ok: false, status: 404 });
      const folder = await guard.authorizeFolder(viewer, alicesFolder, "view");
      expect(folder).toMatchObject({ ok: false, status: 404 });
    });

    test("while a shop restricts nothing, roles that edit documents still can't touch it", async () => {
      stage.restricting = false;
      try {
        const bob = await as("u_bob"); // a planner: knowledge:write
        for (const capability of ["view", "edit", "delete"] as const) {
          expect(
            await guard.authorizeDocument(bob, doc.secret, capability)
          ).toMatchObject({ ok: false, status: 404 });
        }
        expect(
          await guard.authorizeFolder(bob, alicesFolder, "edit")
        ).toMatchObject({ ok: false, status: 404 });
      } finally {
        stage.restricting = true;
      }
    });

    test("a grant written straight into the database doesn't open it", async () => {
      await database.accessGrant.create({
        data: {
          orgId,
          folderId: alicesFolder,
          principalType: "everyone",
          principalId: "",
          capabilities: ALL,
        },
      });
      try {
        const owner = await as("u_owner");
        expect((await access.folderCapabilities(owner)).get(alicesFolder)).toBe(
          0
        );
        expect((await access.documentCapabilities(owner)).get(doc.secret)).toBe(
          0
        );
      } finally {
        await database.accessGrant.deleteMany({
          where: { orgId, folderId: alicesFolder },
        });
      }
    });

    test("folders inside it are hers alone too", async () => {
      const alice = await as("u_alice");
      const made = await folders.createFolder(alice, alicesFolder, "Taxes");
      if (!made.ok) {
        throw new Error(made.error);
      }
      await addDoc(doc.deep, "2026 return", made.id, "u_alice");
      const owner = await as("u_owner");
      expect((await access.folderCapabilities(owner)).get(made.id)).toBe(0);
      expect((await access.documentCapabilities(owner)).get(doc.deep)).toBe(0);
      expect((await access.documentCapabilities(alice)).get(doc.deep)).toBe(
        ALL
      );
    });
  });

  describe("Ask Takumo and facts", () => {
    test("only Alice's questions may draw on her documents", async () => {
      expect(await ai.usableSourceIds(await as("u_alice"), "full")).toContain(
        doc.secret
      );
      for (const userId of ["u_owner", "u_admin", "u_bob"]) {
        expect(
          await ai.usableSourceIds(await as(userId), "search")
        ).not.toContain(doc.secret);
      }
    });

    test("a fact from her document is seen by her alone", async () => {
      const fact = await database.fact.create({
        data: {
          orgId,
          number: 1,
          subjectType: "shop",
          subjectId: orgId,
          subjectLabel: "Personal test",
          attribute: "note",
          value: "salary expectation",
          source: "document",
          status: "approved",
          provenance: "documents",
          sources: { create: [{ orgId, sourceId: doc.secret }] },
        } as never,
      });
      expect(await ai.visibleFactIds(await as("u_alice"))).toContain(fact.id);
      expect(await ai.visibleFactIds(await as("u_owner"))).not.toContain(
        fact.id
      );
      // Ask Takumo's SQL tool reads facts as nobody in particular.
      const [row] = await database.$queryRawUnsafe<{ n: number }[]>(
        "select count(*)::int as n from library.fact_access($1, null, null) where fact_id = $2",
        orgId,
        fact.id
      );
      expect(row.n).toBe(0);
      await database.fact.delete({ where: { id: fact.id } });
    });

    test("no shop facts are proposed from a personal document", async () => {
      expect(await personal.isPersonalDocument(orgId, doc.secret)).toBe(true);
      expect(await personal.isPersonalDocument(orgId, doc.shared)).toBe(false);
    });
  });

  describe("nothing in it is shared", () => {
    test("Alice can't share her folder or a document in it", async () => {
      const alice = await as("u_alice");
      for (const target of [
        { folderId: alicesFolder },
        { sourceId: doc.secret },
      ]) {
        expect(
          await grants.grantAccess(alice, target, { type: "everyone" }, 3)
        ).toEqual({ ok: false, error: personal.NOT_SHAREABLE });
      }
    });

    test("it can't be renamed, moved or deleted", async () => {
      const alice = await as("u_alice");
      expect(await folders.renameFolder(alice, alicesFolder, "Mine")).toEqual(
        folders.DEFAULT_FIXED
      );
      expect(await moves.moveFolder(alice, alicesFolder, null)).toEqual(
        folders.DEFAULT_FIXED
      );
      expect(await moves.deleteFolder(alice, alicesFolder)).toEqual(
        folders.DEFAULT_FIXED
      );
    });

    test("only your own uploads can go in: nobody hides the shop's documents", async () => {
      // The owner may edit every shop document, but moving Bob's drawing into
      // their Personal folder would hide it from everyone else.
      const owner = await as("u_owner");
      await personal.ensurePersonalFolder(owner);
      const ownersFolder = (
        await database.folder.findFirstOrThrow({
          where: { orgId, personalUserId: "u_owner" },
        })
      ).id;
      expect(await moves.moveDocument(owner, doc.bobs, ownersFolder)).toEqual({
        ok: false,
        status: 403,
        error: "Only documents you uploaded can go into your Personal folder.",
      });
      // Their own upload may go in, and then only they see it.
      const own = id();
      const publicId = (await folders.publicFolderId(orgId)) as string;
      await addDoc(own, "Owner's draft budget", publicId, "u_owner");
      expect(await moves.moveDocument(owner, own, ownersFolder)).toEqual({
        ok: true,
      });
      expect(
        (await access.documentCapabilities(await as("u_admin"))).get(own)
      ).toBe(0);
      // Nor can a folder from the shop be moved in.
      const shopFolder = await folders.createFolder(owner, null, "Budgets");
      if (!shopFolder.ok) {
        throw new Error(shopFolder.error);
      }
      expect(
        await moves.moveFolder(owner, shopFolder.id, ownersFolder)
      ).toMatchObject({ ok: false, status: 403 });
    });

    test("deleting a folder inside it keeps its Trash inside it", async () => {
      // A shop that restricts access refuses to delete a folder with
      // documents in the Trash; one that doesn't moves them out.
      stage.restricting = false;
      const alice = await as("u_alice");
      const made = await folders.createFolder(alice, alicesFolder, "Old");
      if (!made.ok) {
        throw new Error(made.error);
      }
      const trashed = id();
      await addDoc(trashed, "Old CV", made.id, "u_alice");
      expect((await lifecycle.trashDocument(alice, trashed)).ok).toBe(true);
      expect((await moves.deleteFolder(alice, made.id)).ok).toBe(true);
      const after = await database.source.findUniqueOrThrow({
        where: { id: trashed },
      });
      // Not the top of the library, where restoring it would show everyone.
      expect(after.folderId).toBe(alicesFolder);
      stage.restricting = true;
    });
  });

  describe("when someone leaves", () => {
    test("their folder waits 30 days, then is deleted with everything in it", async () => {
      members.delete(`${orgId}:u_alice`);
      const now = new Date();
      await sweep.sweepPersonalFolders(now);
      const marked = await database.folder.findUniqueOrThrow({
        where: { id: alicesFolder },
      });
      const days = Math.round(
        ((marked.deleteAfter as Date).getTime() - now.getTime()) / 86_400_000
      );
      expect(days).toBe(30);
      // Not yet: nothing is deleted before the grace period ends.
      await sweep.sweepPersonalFolders(new Date(now.getTime() + 86_400_000));
      expect(await database.source.count({ where: { id: doc.secret } })).toBe(
        1
      );
      // After it, her documents and folders are gone for good.
      await sweep.sweepPersonalFolders(
        new Date(now.getTime() + 31 * 86_400_000)
      );
      expect(
        await database.source.count({
          where: { id: { in: [doc.secret, doc.deep] } },
        })
      ).toBe(0);
      expect(
        await database.folder.count({
          where: { orgId, personalUserId: "u_alice" },
        })
      ).toBe(0);
      // What she shared, in Public, is untouched.
      expect(
        await database.source.count({
          where: { id: { in: [doc.bobs, doc.shared] } },
        })
      ).toBe(2);
    });

    test("back within the grace period, they keep it", async () => {
      members.set(`${orgId}:u_bob2`, "operator");
      const bob2 = await as("u_bob2");
      await personal.ensurePersonalFolder(bob2);
      members.delete(`${orgId}:u_bob2`);
      await personal.markLeaverFolder(orgId, "u_bob2");
      members.set(`${orgId}:u_bob2`, "operator");
      await personal.ensurePersonalFolder(await as("u_bob2"));
      const folder = await database.folder.findFirstOrThrow({
        where: { orgId, personalUserId: "u_bob2" },
      });
      expect(folder.deleteAfter).toBeNull();
    });
  });

  describe("Public and the library", () => {
    test("a new shop uses the library, with a Public folder everyone can add to", async () => {
      const other = `org_pub_${id().slice(0, 8)}`;
      members.set(`${other}:u_x`, "operator");
      try {
        const org = await database.org.create({
          data: { id: other, name: "New shop" },
        });
        expect(org.libraryStage).toBe("library");
        const publicId = await folders.publicFolderId(other);
        expect(publicId).toBeTruthy();
        const viewer = await viewers.viewerForMember(other, "u_x");
        expect(
          (await access.folderCapabilities(viewer as Viewer)).get(
            publicId as string
          )
        ).toBe(7);
      } finally {
        await database.org.deleteMany({ where: { id: other } });
      }
    });
  });
});
