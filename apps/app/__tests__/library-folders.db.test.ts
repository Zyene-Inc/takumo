// @vitest-environment node
// The Company Knowledge Library's folders against a real database (phase 3):
// default folders, browsing and breadcrumbs, creating, renaming, moving and
// deleting folders, moving documents, and the server actions behind them,
// for the right people only and never across shops. Runs only with
// TEST_DATABASE_URL.
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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/auth/server", () => ({
  auth: async () => h.state.session,
  shopRole: async () => null,
  listShopMembers: async () => [
    { userId: "user_planner", name: "Pat Planner" },
    { userId: "user_operator", name: "Olu Operator" },
  ],
}));
vi.mock("../lib/library/storage", async (original) => ({
  ...(await original<object>()),
  objectStore: () => h.state.store,
}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

type Db = typeof import("@repo/database");

describe.skipIf(!TEST_DATABASE_URL)("library folders (database)", () => {
  let database: Db["database"];
  let browse: typeof import("../lib/library/browse");
  let folders: typeof import("../lib/library/folders");
  let viewers: typeof import("../lib/library/viewer");
  let actions: typeof import("../app/(authenticated)/library/actions");
  let documents: typeof import("../lib/knowledge/documents");
  let orgId = "";
  let otherOrgId = "";

  const as = async (role: string, userId = `user_${role}`, org = orgId) => {
    h.state.session = { orgId: org, userId, role };
    const viewer = await viewers.resolveViewer();
    if (!viewer) {
      throw new Error("expected a viewer");
    }
    return viewer;
  };

  /** A document stored as Takumo stores sample text (no reading needed). */
  const doc = async (name: string, folderId: string | null, org = orgId) => {
    const stored = await documents.storeDocument(
      org,
      name,
      `About ${name}.`,
      [{ content: `${name} text.`, heading: null, page: 1 }],
      { mayReplace: false }
    );
    if (folderId) {
      await database.source.update({
        where: { id: stored.sourceId },
        data: { folderId },
      });
    }
    return stored.sourceId;
  };

  const made = (result: { ok: boolean; id?: string }) => {
    if (!(result.ok && result.id)) {
      throw new Error(`expected a folder: ${JSON.stringify(result)}`);
    }
    return result.id;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SKIP_ENV_VALIDATION = "true";
    ({ database } = await import("@repo/database"));
    browse = await import("../lib/library/browse");
    folders = await import("../lib/library/folders");
    viewers = await import("../lib/library/viewer");
    actions = await import("../app/(authenticated)/library/actions");
    documents = await import("../lib/knowledge/documents");
  });

  beforeEach(async () => {
    h.resetState();
    orgId = `org_fold_${randomUUID().slice(0, 8)}`;
    otherOrgId = `org_fold_other_${randomUUID().slice(0, 8)}`;
    for (const id of [orgId, otherOrgId]) {
      await database.org.create({
        data: {
          id,
          name: "Folders",
          ownerUserId: "user_owner",
          libraryStage: "library",
        },
      });
    }
  });

  afterAll(async () => {
    await database?.org.deleteMany({
      where: { id: { startsWith: "org_fold_" } },
    });
  });

  describe("navigation", () => {
    test("the default folders are made once, even when asked for at the same time", async () => {
      const viewer = await as("operator");
      await Promise.all([1, 2, 3].map(() => browse.libraryNav(viewer)));
      const nav = await browse.libraryNav(viewer);
      // Their own Personal folder first, then the shared defaults.
      expect(nav.map((f) => f.name)).toEqual([
        "Personal",
        "Public",
        "SOPs",
        "Engineering",
      ]);
      expect(
        await database.folder.count({ where: { orgId, kind: "system" } })
      ).toBe(3);
      // One Personal folder for this person, however many visits race.
      expect(
        await database.folder.count({
          where: { orgId, personalUserId: viewer.userId },
        })
      ).toBe(1);
      // Everyone can see and add to the shared ones.
      const view = await browse.folderView(viewer, nav[1].id);
      expect(view?.canAdd).toBe(true);
    });

    test("a custom folder already called SOPs is kept, not duplicated", async () => {
      const planner = await as("planner");
      await actions.createFolder(null, "SOPs");
      await browse.libraryNav(planner);
      const sops = await database.folder.findMany({
        where: { orgId, name: "SOPs" },
      });
      expect(sops).toHaveLength(1);
    });

    test("browsing nested folders: contents, breadcrumbs and empty folders", async () => {
      const planner = await as("planner");
      const plant = made(await actions.createFolder(null, "Plant 2"));
      const cells = made(await actions.createFolder(plant, "Cells"));
      const lathe = made(await actions.createFolder(cells, "Lathe cell"));
      await doc("Lathe setup", lathe);
      await doc("Loose memo", null);

      const top = await browse.folderView(planner, null);
      expect(top?.folders.map((f) => f.name)).toContain("Plant 2");
      expect(top?.documents.map((d) => d.name)).toEqual(["Loose memo"]);

      const deep = await browse.folderView(planner, lathe);
      expect(deep?.trail.map((t) => t.name)).toEqual(["Plant 2", "Cells"]);
      expect(deep?.documents.map((d) => d.name)).toEqual(["Lathe setup"]);
      expect(
        (await browse.folderView(planner, plant))?.folders[0]
      ).toMatchObject({ name: "Cells", folders: 1, documents: 0 });

      const empty = made(await actions.createFolder(plant, "Empty"));
      expect(await browse.folderView(planner, empty)).toMatchObject({
        folders: [],
        documents: [],
      });
    });

    test("another shop's folders aren't found", async () => {
      await as("admin", "user_admin", otherOrgId);
      const theirs = made(await actions.createFolder(null, "Their folder"));
      const viewer = await as("admin");
      expect(await browse.folderView(viewer, theirs)).toBeNull();
      expect(
        (await browse.folderChoices(viewer)).some((c) => c.id === theirs)
      ).toBe(false);
      for (const result of [
        await actions.renameFolder(theirs, "Mine now"),
        await actions.createFolder(theirs, "Inside"),
        await actions.deleteFolder(theirs),
        await actions.moveFolder(theirs, null),
      ]) {
        expect(result).toEqual({
          ok: false,
          error: "That folder doesn't exist.",
        });
      }
      expect(
        (await database.folder.findUniqueOrThrow({ where: { id: theirs } }))
          .name
      ).toBe("Their folder");
    });
  });

  describe("changing folders", () => {
    test("names are checked, and clashes and depth explained", async () => {
      await as("planner");
      expect(await actions.createFolder(null, "   ")).toEqual({
        ok: false,
        error: "Give the folder a name.",
      });
      expect(await actions.createFolder(null, "x".repeat(121))).toMatchObject({
        ok: false,
      });
      const quality = made(await actions.createFolder(null, "Quality"));
      expect(await actions.createFolder(null, "Quality")).toEqual({
        ok: false,
        error:
          "There's already a folder called Quality here. Choose another name.",
      });
      // Twenty levels deep, and no deeper.
      let parent = quality;
      for (let depth = 2; depth <= 20; depth += 1) {
        parent = made(await actions.createFolder(parent, `Level ${depth}`));
      }
      expect(await actions.createFolder(parent, "Too deep")).toEqual({
        ok: false,
        error: "Folders can be nested at most 20 levels deep.",
      });
    });

    test("operators can't create, rename or delete folders; they can add documents", async () => {
      await as("planner");
      const shared = made(await actions.createFolder(null, "Shared"));
      const operator = await as("operator");
      expect(await actions.createFolder(null, "Mine")).toMatchObject({
        ok: false,
      });
      expect(await actions.createFolder(shared, "Mine")).toMatchObject({
        ok: false,
      });
      expect(await actions.renameFolder(shared, "Renamed")).toMatchObject({
        ok: false,
      });
      expect(await actions.deleteFolder(shared)).toMatchObject({ ok: false });
      expect((await browse.folderView(operator, shared))?.canAdd).toBe(true);
      expect((await browse.folderView(operator, shared))?.canManage).toBe(
        false
      );
    });

    test("renaming and moving; default folders stay put; a folder can't go inside itself", async () => {
      const planner = await as("planner");
      const [general] = await browse.libraryNav(planner);
      expect(await actions.renameFolder(general.id, "Misc")).toMatchObject({
        ok: false,
      });
      const a = made(await actions.createFolder(null, "A"));
      const b = made(await actions.createFolder(a, "B"));
      expect(await actions.renameFolder(a, "Alpha")).toEqual({ ok: true });
      expect(await actions.moveFolder(a, b)).toEqual({
        ok: false,
        error: "A folder can't be moved inside itself.",
      });
      // B moves to the top, and everyone can still see what's in it.
      await doc("Inside B", b);
      expect(await actions.moveFolder(b, null)).toEqual({ ok: true });
      const operator = await as("operator");
      expect(
        (await browse.folderView(operator, b))?.documents.map((d) => d.name)
      ).toEqual(["Inside B"]);
      const audit = await database.documentAuditLog.findMany({
        where: { orgId, folderId: { in: [a, b] } },
        select: { action: true },
      });
      expect(audit.map((x) => x.action)).toEqual(
        expect.arrayContaining([
          "folder_create",
          "folder_rename",
          "folder_move",
        ])
      );
    });

    test("only empty folders are deleted; documents in the Trash from it go to the top", async () => {
      await as("planner");
      const box = made(await actions.createFolder(null, "Box"));
      const sub = made(await actions.createFolder(box, "Sub"));
      expect(await actions.deleteFolder(box)).toMatchObject({ ok: false });
      expect(await actions.deleteFolder(sub)).toEqual({ ok: true });
      const kept = await doc("Kept", box);
      expect(await actions.deleteFolder(box)).toMatchObject({ ok: false });
      await database.source.update({
        where: { id: kept },
        data: { deletedAt: new Date() },
      });
      expect(await actions.deleteFolder(box)).toEqual({ ok: true });
      expect(
        (await database.source.findUniqueOrThrow({ where: { id: kept } }))
          .folderId
      ).toBeNull();
    });
  });

  describe("moving documents", () => {
    test("a planner moves a document; a clash in the target is refused", async () => {
      await as("planner");
      const a = made(await actions.createFolder(null, "From"));
      const b = made(await actions.createFolder(null, "To"));
      const sop = await doc("SOP 9", a);
      // Another "SOP 9" already in "To".
      await doc("SOP 9", b);
      expect(await actions.moveDocument(sop, b)).toEqual({
        ok: false,
        error: "There's already a document called SOP 9 in that folder.",
      });
      const c = made(await actions.createFolder(null, "Other"));
      expect(await actions.moveDocument(sop, c)).toEqual({ ok: true });
      expect(
        (await database.source.findUniqueOrThrow({ where: { id: sop } }))
          .folderId
      ).toBe(c);
    });

    test("an operator can't move documents; another shop's folder isn't a target", async () => {
      await as("planner");
      const mine = made(await actions.createFolder(null, "Mine"));
      const sop = await doc("Mine doc", mine);
      await as("admin", "user_admin", otherOrgId);
      const theirs = made(await actions.createFolder(null, "Theirs"));
      await as("operator");
      expect(await actions.moveDocument(sop, null)).toMatchObject({
        ok: false,
      });
      await as("planner");
      expect(await actions.moveDocument(sop, theirs)).toEqual({
        ok: false,
        error: "That folder doesn't exist.",
      });
      expect(
        (await database.source.findUniqueOrThrow({ where: { id: sop } }))
          .folderId
      ).toBe(mine);
    });
  });

  describe("who can use the library", () => {
    test("someone no longer in the shop gets nothing and changes nothing", async () => {
      h.state.session = { orgId: null, userId: "user_gone", role: null };
      expect(await viewers.resolveViewer()).toBeNull();
      expect(await actions.createFolder(null, "Sneaky")).toEqual({
        ok: false,
        error: "That folder doesn't exist.",
      });
      expect(await database.folder.count({ where: { orgId } })).toBe(0);
    });

    test("with the library off, its actions do nothing", async () => {
      await database.org.update({
        where: { id: orgId },
        data: { libraryStage: "off" },
      });
      await as("owner", "user_owner");
      expect(await actions.createFolder(null, "Off")).toMatchObject({
        ok: false,
      });
      expect(await database.folder.count({ where: { orgId } })).toBe(0);
    });

    test("ids that aren't ids are refused before anything runs", async () => {
      await as("planner");
      expect(
        await actions.renameFolder('\'; drop table "Folder"; --', "x")
      ).toMatchObject({ ok: false });
      expect(
        await actions.moveDocument("../../etc/passwd", null)
      ).toMatchObject({ ok: false });
    });
  });

  test("folderName trims, collapses spaces and refuses control characters", () => {
    expect(folders.folderName("  Quality   docs ")).toEqual({
      ok: true,
      name: "Quality docs",
    });
    expect(folders.folderName("bad\u0000name").ok).toBe(false);
    expect(folders.folderName(42).ok).toBe(false);
  });
});
