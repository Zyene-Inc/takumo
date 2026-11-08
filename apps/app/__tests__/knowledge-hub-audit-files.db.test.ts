// @vitest-environment node
// Security audit regressions (Knowledge Hub phase 4), files and folder
// listings: L2 (someone with only "view" got the original file through the
// open link and the in-page preview), L5 (a drop-box upload was named
// "Name (2)" only when a hidden document already had that name, so the
// uploader could test guesses) and L6 (a viewer of a subfolder learned a
// confidential parent's name from the breadcrumbs, folder pickers and
// department lists, and hidden folders and documents from the counts on
// folder cards). These are the auditor's exploit steps, asserting they now
// fail. Restricted access is switched off in code; these tests switch it on.
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

// Active WorkOS memberships, "shop:user" → role (WorkOS is mocked).
const members = new Map<string, string>();
vi.mock("@repo/auth/server", () => ({
  auth: vi.fn(),
  shopRole: async (userId: string, orgId: string) =>
    members.get(`${orgId}:${userId}`) ?? null,
  listShopMembers: async () => [],
}));
vi.mock("../lib/library/stage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confidentialEnabled: async () => true,
  restrictedAccessReady: () => true,
}));

// Original files in memory instead of Supabase Storage.
const store = vi.hoisted(() => ({
  objects: new Map<string, Uint8Array>(),
  put(key: string, bytes: Uint8Array) {
    this.objects.set(key, bytes);
    return Promise.resolve();
  },
  get(key: string) {
    return Promise.resolve(this.objects.get(key) ?? new Uint8Array());
  },
  remove() {
    return Promise.resolve();
  },
  signedUrl(key: string, options: { downloadAs?: string }) {
    return Promise.resolve(
      `https://storage.test/${key}?token=t${options.downloadAs ? "&download" : ""}`
    );
  },
}));
vi.mock("../lib/library/storage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  objectStore: () => store,
}));

type Db = typeof import("@repo/database");
type Viewer = import("../lib/library/viewer").Viewer;

const id = () => randomUUID();
const VIEW = 1;
const VIEW_DOWNLOAD = 3;
const CONTRIBUTOR = 7;
const EDITOR = 31;
const UPLOAD = 4;

// Names a viewer of the subfolder must never learn.
const BOARD = "Board - Acquisition of Rival Inc";
const SECRET_FOLDER = "Severance Planning";
const SECRET_DOC = "termination-list";
const SECRET_IN_ROUTES = "night-shift-cuts";
const SECRET_IN_SHARED = "salary-bands";
const SECRET_SHARED_FOLDER = "Pay Review";
const SECRETS = [
  BOARD,
  SECRET_FOLDER,
  SECRET_DOC,
  SECRET_IN_ROUTES,
  SECRET_IN_SHARED,
  SECRET_SHARED_FOLDER,
];
const leaked = (value: unknown) => {
  const text = JSON.stringify(value);
  return SECRETS.filter((s) => text.includes(s));
};

// A drop-box name: always "<name> (<6 hex>)", never "(2)".
const TAGGED = /^severance-c[ef]o \([0-9a-f]{6}\)$/;

describe.skipIf(!TEST_DATABASE_URL)(
  "security audit: files and folder listings (L2, L5, L6)",
  () => {
    const orgId = `org_audit_files_${id().slice(0, 8)}`;
    let database: Db["database"];
    let viewers: typeof import("../lib/library/viewer");
    let download: typeof import("../lib/library/download");
    let versions: typeof import("../lib/library/versions");
    let browse: typeof import("../lib/library/browse");
    let access: typeof import("../lib/library/access");
    let departments: typeof import("../lib/library/departments");

    const f = {
      shared: id(),
      sharedSecret: id(),
      board: id(),
      logistics: id(),
      routes: id(),
      severance: id(),
      drop: id(),
    };
    const doc = { priceList: id() };
    const boardTeam = id();

    const as = async (userId: string): Promise<Viewer> => {
      const v = await viewers.viewerForMember(orgId, userId);
      if (!v) {
        throw new Error(`${userId} isn't a member`);
      }
      return v;
    };

    const addSource = (
      name: string,
      folderId: string,
      extra: { inheritAccess?: boolean; sourceId?: string } = {}
    ) =>
      database.source.create({
        data: {
          id: extra.sourceId ?? id(),
          orgId,
          name,
          type: "upload",
          profile: "document",
          status: "ready",
          folderId,
          uploadedBy: "u_owner",
          ...(extra.inheritAccess === undefined
            ? {}
            : { inheritAccess: extra.inheritAccess }),
        },
      });

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      ({ database } = await import("@repo/database"));
      viewers = await import("../lib/library/viewer");
      download = await import("../lib/library/download");
      versions = await import("../lib/library/versions");
      browse = await import("../lib/library/browse");
      access = await import("../lib/library/access");
      departments = await import("../lib/library/departments");
      for (const [user, role] of [
        ["u_owner", "admin"],
        ["u_admin", "admin"],
        ["u_op", "operator"],
        ["u_op2", "operator"],
        ["u_board", "member"],
      ]) {
        members.set(`${orgId}:${user}`, role);
      }
      await database.org.create({
        data: {
          id: orgId,
          name: "Audit files",
          ownerUserId: "u_owner",
          libraryStage: "confidential",
        },
      });

      // Shared: u_op may only view, u_op2 may view and download. A folder
      // and a document inside stop inheriting, so u_op can't see them.
      await database.folder.create({
        data: { id: f.shared, orgId, name: "Shared" },
      });
      await database.accessGrant.createMany({
        data: [
          { user: "u_op", capabilities: VIEW },
          { user: "u_op2", capabilities: VIEW_DOWNLOAD },
        ].map((g) => ({
          orgId,
          folderId: f.shared,
          principalType: "user",
          principalId: g.user,
          capabilities: g.capabilities,
        })),
      });
      await database.folder.create({
        data: {
          id: f.sharedSecret,
          orgId,
          name: SECRET_SHARED_FOLDER,
          parentId: f.shared,
          inheritAccess: false,
        },
      });
      await addSource(SECRET_IN_SHARED, f.shared, { inheritAccess: false });
      await addSource("price-list", f.shared, { sourceId: doc.priceList });
      const versionId = id();
      const key = `org/${orgId}/src/${doc.priceList}/v1/${"a".repeat(64)}`;
      await database.documentVersion.create({
        data: {
          id: versionId,
          orgId,
          sourceId: doc.priceList,
          number: 1,
          name: "price-list.pdf",
          storageKey: key,
          originalKept: true,
          mimeType: "application/pdf",
          size: 10,
          status: "ready",
        },
      });
      await database.source.update({
        where: { id: doc.priceList },
        data: { currentVersionId: versionId, versionSeq: 1 },
      });
      store.objects.set(key, new TextEncoder().encode("%PDF-1.4 x"));

      // A confidential Board folder (only the board's department), with
      // Logistics inside it that u_op may use. In Logistics: a document and
      // a folder that stop inheriting (hidden from u_op), and Routes, which
      // u_op sees, holding one document for them and one hidden one.
      await database.department.create({
        data: { id: boardTeam, orgId, name: "Board members" },
      });
      await database.departmentMember.create({
        data: { orgId, departmentId: boardTeam, userId: "u_board" },
      });
      await database.folder.create({
        data: {
          id: f.board,
          orgId,
          name: BOARD,
          confidential: true,
          inheritAccess: false,
        },
      });
      await database.folder.create({
        data: {
          id: f.logistics,
          orgId,
          name: "Logistics",
          parentId: f.board,
          inheritAccess: false,
        },
      });
      await database.folder.createMany({
        data: [
          { id: f.routes, orgId, name: "Routes", parentId: f.logistics },
          {
            id: f.severance,
            orgId,
            name: SECRET_FOLDER,
            parentId: f.logistics,
            inheritAccess: false,
          },
        ],
      });
      const secretDoc = await addSource(SECRET_DOC, f.logistics, {
        inheritAccess: false,
      });
      await addSource("route-sheet", f.logistics);
      await addSource("truck-schedule", f.routes);
      await addSource(SECRET_IN_ROUTES, f.routes, { inheritAccess: false });
      await database.accessGrant.createMany({
        data: [
          {
            orgId,
            folderId: f.board,
            principalType: "department",
            principalId: boardTeam,
            capabilities: EDITOR,
          },
          {
            orgId,
            sourceId: secretDoc.id,
            principalType: "department",
            principalId: boardTeam,
            capabilities: EDITOR,
          },
          {
            orgId,
            folderId: f.logistics,
            principalType: "user",
            principalId: "u_op",
            capabilities: CONTRIBUTOR,
          },
        ],
      });

      // A drop box (like Receipts): everyone may only upload.
      await database.folder.create({
        data: {
          id: f.drop,
          orgId,
          name: "Receipts",
          confidential: true,
          inheritAccess: false,
        },
      });
      await database.accessGrant.create({
        data: {
          orgId,
          folderId: f.drop,
          principalType: "everyone",
          principalId: "",
          capabilities: UPLOAD,
        },
      });
      await addSource("severance-ceo", f.drop);
    });

    afterAll(async () => {
      await database?.org.deleteMany({ where: { id: orgId } });
    });

    test("L2: view-only can't open, download or preview the original file", async () => {
      const op = await as("u_op");
      const caps = (await access.accessTo(op, { sourceId: doc.priceList }))
        ?.capabilities;
      expect(caps).toBe(VIEW);
      const results = [
        await download.fileLink(op, doc.priceList, { download: true }),
        await download.fileLink(op, doc.priceList, { download: false }),
        await download.fileLink(op, doc.priceList, {
          download: false,
          version: 1,
        }),
        await download.previewFile(op, doc.priceList),
      ];
      for (const result of results) {
        expect(result.ok).toBe(false);
        expect(result.ok ? 0 : result.status).toBe(403);
        expect(JSON.stringify(result)).not.toContain("storage.test");
        expect(JSON.stringify(result)).not.toContain("%PDF");
      }
      // Nothing was handed over, so nothing was logged as opened.
      expect(
        await database.documentAuditLog.count({
          where: {
            orgId,
            actorId: "u_op",
            action: { in: ["download", "preview"] },
          },
        })
      ).toBe(0);
    });

    test("L2: view and download still gets the link and the preview", async () => {
      const op2 = await as("u_op2");
      const saved = await download.fileLink(op2, doc.priceList, {
        download: true,
      });
      expect(saved.ok && saved.url).toContain("&download");
      const opened = await download.fileLink(op2, doc.priceList, {
        download: false,
      });
      expect(opened.ok && opened.url).toContain("https://storage.test/");
      const preview = await download.previewFile(op2, doc.priceList);
      expect(preview.ok).toBe(true);
      expect(
        preview.ok ? new TextDecoder().decode(preview.bytes) : preview
      ).toBe("%PDF-1.4 x");
    });

    test("L5: a drop-box upload is tagged the same way whether or not the name is taken", async () => {
      const file = (name: string, body: string) => ({
        name,
        bytes: new TextEncoder().encode(`%PDF-1.4 ${body}`),
        mimeType: "application/pdf",
      });
      const upload = (name: string, body: string) =>
        versions.createDocument(
          orgId,
          "u_op",
          file(name, body),
          "upload",
          f.drop,
          { hidden: true }
        );
      // "severance-ceo" exists (hidden from u_op); "severance-cfo" doesn't.
      const taken = await upload("severance-ceo.pdf", "y");
      const free = await upload("severance-cfo.pdf", "z");
      const again = await upload("severance-cfo.pdf", "w");
      for (const made of [taken, free, again]) {
        expect(made.name).toMatch(TAGGED);
        expect(made.name).not.toContain("(2)");
        const row = await database.source.findUnique({
          where: { id: made.sourceId },
          select: { name: true },
        });
        expect(row?.name).toBe(made.name);
      }
      expect(again.name).not.toBe(free.name);
      // What u_op sees afterwards (My uploads) has the same shape too.
      const mine = await browse.myUploads(await as("u_op"));
      const names = mine.map((m) => m.name).sort();
      expect(names).toHaveLength(3);
      for (const name of names) {
        expect(name).toMatch(TAGGED);
      }
      expect(names).not.toContain("severance-ceo");
    });

    test("L6: breadcrumbs, contents and card counts of a subfolder show only what the viewer may see", async () => {
      const op = await as("u_op");
      const view = await browse.folderView(op, f.logistics);
      expect(view).not.toBeNull();
      expect(view?.folder?.name).toBe("Logistics");
      // The confidential parent isn't in the trail at all.
      expect(view?.trail).toEqual([]);
      expect(view?.trail.map((t) => t.id)).not.toContain(f.board);
      expect(view?.documents.map((d) => d.name)).toEqual(["route-sheet"]);
      // Routes counts only what u_op may see; the hidden folder isn't listed.
      expect(
        view?.folders.map((c) => [c.name, c.folders, c.documents])
      ).toEqual([["Routes", 0, 1]]);
      expect(leaked(view)).toEqual([]);

      const routes = await browse.folderView(op, f.routes);
      expect(routes?.trail.map((t) => t.name)).toEqual(["Logistics"]);
      expect(routes?.documents.map((d) => d.name)).toEqual(["truck-schedule"]);
      expect(leaked(routes)).toEqual([]);

      // The confidential parent itself isn't reachable.
      expect(await browse.folderView(op, f.board)).toBeNull();
    });

    test("L6: top-level folder cards count only visible folders and documents", async () => {
      const op = await as("u_op");
      const top = await browse.folderView(op, null);
      const shared = top?.folders.find((c) => c.id === f.shared);
      expect(shared).toMatchObject({ folders: 0, documents: 1 });
      expect(top?.folders.map((c) => c.id)).not.toContain(f.board);
      expect(leaked(top)).toEqual([]);
      const nav = await browse.libraryNav(op);
      expect(nav.find((c) => c.id === f.shared)).toMatchObject({
        folders: 0,
        documents: 1,
      });
      expect(leaked(nav)).toEqual([]);
      // Someone who may see everything in Shared gets the full counts.
      const owner = await as("u_owner");
      const ownerTop = await browse.folderView(owner, null);
      expect(ownerTop?.folders.find((c) => c.id === f.shared)).toMatchObject({
        folders: 1,
        documents: 2,
      });
    });

    test("L6: Move-to choices show hidden folders above as …", async () => {
      const op = await as("u_op");
      const choices = await browse.folderChoices(op);
      const labels = new Map(choices.map((c) => [c.id, c.label]));
      expect(labels.get(f.logistics)).toBe("… / Logistics");
      expect(labels.get(f.routes)).toBe("… / Logistics / Routes");
      expect(labels.has(f.board)).toBe(false);
      expect(labels.has(f.severance)).toBe(false);
      expect(leaked(choices.map((c) => c.label))).toEqual([]);
    });

    test("L6: departments list folders and documents the viewer can't open without their names", async () => {
      const admin = await as("u_admin");
      const list = await departments.listDepartments(admin);
      const board = list.find((d) => d.id === boardTeam);
      expect(board?.access.map((a) => a.name).sort()).toEqual([
        "A document you can't open",
        "A folder you can't open",
      ]);
      expect(leaked(list)).toEqual([]);
      // A member of the department sees the real names.
      const member = await departments.listDepartments(await as("u_board"));
      expect(
        member
          .find((d) => d.id === boardTeam)
          ?.access.map((a) => a.name)
          .sort()
      ).toEqual([BOARD, SECRET_DOC]);
    });
  }
);
