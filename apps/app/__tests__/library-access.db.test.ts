// @vitest-environment node
// Company Knowledge Hub access, against a real database: the library.* SQL
// functions decide who may do what with folders and documents, and triggers
// keep folder paths and same-shop references right. Runs only with
// TEST_DATABASE_URL.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

vi.mock("server-only", () => ({}));
vi.mock("../../../packages/database/node_modules/server-only", () => ({}));
// Active WorkOS memberships, by "shop:user" (WorkOS is mocked).
const memberships = vi.hoisted(() => new Map<string, string>());
vi.mock("@repo/auth/server", () => ({
  auth: vi.fn(),
  shopRole: async (userId: string, orgId: string) =>
    memberships.get(`${orgId}:${userId}`) ?? null,
}));

type Db = typeof import("@repo/database");
type AccessModule = typeof import("../lib/library/access");
type ViewerModule = typeof import("../lib/library/viewer");
type Viewer = import("../lib/library/viewer").Viewer;

const ALL = 63;
const VIEW = 1;
const UPLOAD = 4;
const VIEWER = 3;
const EDITOR = 31;

const id = () => randomUUID();

describe.skipIf(!TEST_DATABASE_URL)("knowledge hub access (database)", () => {
  const orgId = `org_lib_${id().slice(0, 8)}`;
  const otherOrgId = `org_lib_other_${id().slice(0, 8)}`;
  let database: Db["database"];
  let access: AccessModule;
  let viewers: ViewerModule;

  // Departments, folders and documents of the test shop.
  const dept = { eng: id(), hr: id() };
  const folder = {
    general: id(),
    privateNotes: id(),
    engineering: id(),
    drawings: id(),
    hr: id(),
    payroll: id(),
    other: id(),
  };
  const doc = {
    legacy: id(),
    handbook: id(),
    drawing: id(),
    payslips: id(),
    restricted: id(),
    engPlusOperator: id(),
    other: id(),
  };

  /** A member's viewer, made the only way the app can: from WorkOS + database. */
  const person = async (userId: string, role: string, shop = orgId) => {
    memberships.set(`${shop}:${userId}`, role);
    const viewer = await viewers.viewerForMember(shop, userId);
    if (!viewer) {
      throw new Error(`No viewer for ${userId}`);
    }
    return viewer;
  };

  /** What the SQL decides for a shop, user and role passed straight in. */
  const visibleRaw = async (
    shop: string,
    user: string | null,
    role: string | null
  ) =>
    new Set(
      (
        await database.$queryRawUnsafe<{ id: string }[]>(
          "select id from library.visible_source_ids($1, $2, $3) as id",
          shop,
          user,
          role
        )
      ).map((r) => r.id)
    );

  let owner: Viewer;
  let admin: Viewer;
  let engineer: Viewer;
  let hrPerson: Viewer;
  let operator: Viewer;
  let both: Viewer;

  const visible = async (viewer: Viewer) =>
    new Set(await access.visibleSourceIds(viewer));

  const capsOf = async (
    viewer: Viewer,
    target: { folderId: string } | { sourceId: string }
  ) => (await access.accessTo(viewer, target))?.capabilities ?? null;

  const addFolder = (
    folderId: string,
    name: string,
    parentId: string | null,
    extra: { confidential?: boolean; inheritAccess?: boolean } = {},
    org = orgId
  ) =>
    database.folder.create({
      data: { id: folderId, orgId: org, name, parentId, ...extra },
    });

  const addDoc = (
    sourceId: string,
    name: string,
    folderId: string | null,
    extra: { inheritAccess?: boolean } = {},
    org = orgId
  ) =>
    database.source.create({
      data: {
        id: sourceId,
        orgId: org,
        name,
        type: "upload",
        profile: "document",
        status: "ready",
        folderId,
        ...extra,
      },
    });

  const grant = (
    target: { folderId: string } | { sourceId: string },
    principalType: string,
    principalId: string,
    capabilities: number,
    org = orgId
  ) =>
    database.accessGrant.create({
      data: { orgId: org, ...target, principalType, principalId, capabilities },
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SKIP_ENV_VALIDATION = "true";
    ({ database } = await import("@repo/database"));
    access = await import("../lib/library/access");
    viewers = await import("../lib/library/viewer");

    await database.org.createMany({
      data: [
        { id: orgId, name: "Library test", ownerUserId: "user_owner" },
        { id: otherOrgId, name: "Other shop" },
      ],
    });
    await database.department.createMany({
      data: [
        { id: dept.eng, orgId, name: "Engineering" },
        { id: dept.hr, orgId, name: "Human Resources" },
      ],
    });

    await addFolder(folder.general, "General", null);
    await addFolder(folder.privateNotes, "Private notes", folder.general, {
      inheritAccess: false,
    });
    await addFolder(folder.engineering, "Engineering", null);
    await addFolder(folder.drawings, "Drawings", folder.engineering);
    await addFolder(folder.hr, "HR", null, {
      confidential: true,
      inheritAccess: false,
    });
    await addFolder(folder.payroll, "Payroll", folder.hr);
    await addFolder(folder.other, "General", null, {}, otherOrgId);

    await grant({ folderId: folder.general }, "everyone", "", VIEWER);
    await grant(
      { folderId: folder.privateNotes },
      "user",
      "user_operator",
      VIEWER
    );
    await grant(
      { folderId: folder.engineering },
      "department",
      dept.eng,
      EDITOR
    );
    await grant({ folderId: folder.hr }, "department", dept.hr, EDITOR);
    // Everyone may hand documents to HR, and a stray grant to every planner
    // must not open HR up (confidential: whole groups may only upload).
    await grant({ folderId: folder.hr }, "everyone", "", UPLOAD);
    await grant({ folderId: folder.hr }, "role", "planner", VIEWER);
    await grant({ folderId: folder.other }, "everyone", "", ALL, otherOrgId);

    await addDoc(doc.legacy, "Old SOP", null);
    await addDoc(doc.handbook, "Handbook", folder.general);
    await addDoc(doc.drawing, "P-1001 drawing", folder.drawings);
    await addDoc(doc.payslips, "Payslips", folder.payroll);
    await addDoc(doc.restricted, "Disciplinary note", folder.general, {
      inheritAccess: false,
    });
    await grant({ sourceId: doc.restricted }, "user", "user_hr", VIEWER);
    await addDoc(doc.engPlusOperator, "Setup sheet", folder.engineering);
    await grant(
      { sourceId: doc.engPlusOperator },
      "user",
      "user_operator",
      VIEW
    );
    await addDoc(doc.other, "Other shop's doc", folder.other, {}, otherOrgId);

    // Departments are read from the database, never from the viewer.
    await database.departmentMember.createMany({
      data: [
        { orgId, departmentId: dept.eng, userId: "user_eng" },
        { orgId, departmentId: dept.hr, userId: "user_hr" },
        { orgId, departmentId: dept.eng, userId: "user_both" },
        { orgId, departmentId: dept.hr, userId: "user_both" },
      ],
    });

    owner = await person("user_owner", "admin");
    admin = await person("user_admin", "admin");
    engineer = await person("user_eng", "planner");
    hrPerson = await person("user_hr", "member");
    operator = await person("user_operator", "operator");
    both = await person("user_both", "member");
  });

  afterAll(async () => {
    await database?.org.deleteMany({
      where: { id: { in: [orgId, otherOrgId] } },
    });
  });

  describe("who sees which documents", () => {
    test("the owner sees everything, confidential included", async () => {
      expect(await visible(owner)).toEqual(
        new Set([
          doc.legacy,
          doc.handbook,
          doc.drawing,
          doc.payslips,
          doc.restricted,
          doc.engPlusOperator,
        ])
      );
      expect(await capsOf(owner, { folderId: folder.hr })).toBe(ALL);
    });

    test("an admin sees everything except confidential folders", async () => {
      const seen = await visible(admin);
      expect(seen.has(doc.payslips)).toBe(false);
      expect(seen.has(doc.restricted)).toBe(true);
      expect(seen.has(doc.drawing)).toBe(true);
      expect(await capsOf(admin, { folderId: folder.hr })).toBe(UPLOAD);
      expect(await capsOf(admin, { folderId: folder.general })).toBe(ALL);
    });

    test("Engineering sees engineering documents, not HR's", async () => {
      expect(await visible(engineer)).toEqual(
        new Set([doc.legacy, doc.handbook, doc.drawing, doc.engPlusOperator])
      );
      // The planner role's grant on HR is cut down to uploading.
      expect(await capsOf(engineer, { sourceId: doc.payslips })).toBe(UPLOAD);
    });

    test("HR sees HR documents, not Engineering's", async () => {
      expect(await visible(hrPerson)).toEqual(
        new Set([doc.legacy, doc.handbook, doc.payslips, doc.restricted])
      );
      expect(await capsOf(hrPerson, { sourceId: doc.payslips })).toBe(EDITOR);
    });

    test("someone in both departments sees both", async () => {
      const seen = await visible(both);
      expect(seen.has(doc.payslips)).toBe(true);
      expect(seen.has(doc.drawing)).toBe(true);
    });

    test("a per-document grant adds one document, nothing else", async () => {
      expect(await visible(operator)).toEqual(
        new Set([doc.legacy, doc.handbook, doc.engPlusOperator])
      );
      expect(await capsOf(operator, { sourceId: doc.engPlusOperator })).toBe(
        VIEW
      );
    });

    test("background work sees only what everyone may", async () => {
      expect(await visible(viewers.systemViewer(orgId))).toEqual(
        new Set([doc.legacy, doc.handbook])
      );
    });
  });

  describe("inheritance", () => {
    test("a subfolder inherits its parent's grants", async () => {
      expect(await capsOf(engineer, { folderId: folder.drawings })).toBe(
        EDITOR
      );
      expect(await capsOf(hrPerson, { folderId: folder.payroll })).toBe(EDITOR);
    });

    test("a folder that stops inheriting ignores the grants above it", async () => {
      expect(await capsOf(engineer, { folderId: folder.privateNotes })).toBe(0);
      expect(await capsOf(operator, { folderId: folder.privateNotes })).toBe(
        VIEWER
      );
    });

    test("a document that stops inheriting uses only its own grants", async () => {
      expect(await capsOf(engineer, { sourceId: doc.restricted })).toBe(0);
      expect(await capsOf(hrPerson, { sourceId: doc.restricted })).toBe(VIEWER);
      // Not confidential, so admins keep their access to it.
      expect(await capsOf(admin, { sourceId: doc.restricted })).toBe(ALL);
    });

    test("documents stored before folders stay readable by everyone", async () => {
      expect(await capsOf(operator, { sourceId: doc.legacy })).toBe(VIEWER);
    });
  });

  describe("checks for one item", () => {
    test("no view means not found, so IDs reveal nothing", async () => {
      expect(
        await access.requireCapability(
          engineer,
          { sourceId: doc.payslips },
          "view"
        )
      ).toEqual({ ok: false, reason: "not_found" });
      expect(
        await access.requireCapability(engineer, { sourceId: id() }, "view")
      ).toEqual({ ok: false, reason: "not_found" });
    });

    test("view without download is denied, not hidden", async () => {
      expect(
        await access.requireCapability(
          operator,
          { sourceId: doc.engPlusOperator },
          "download"
        )
      ).toEqual({ ok: false, reason: "denied" });
    });

    test("anyone may upload into the HR drop box without seeing it", async () => {
      expect(
        await access.requireCapability(
          operator,
          { folderId: folder.hr },
          "upload"
        )
      ).toMatchObject({ ok: true });
      expect(
        await access.requireCapability(
          operator,
          { folderId: folder.hr },
          "view"
        )
      ).toEqual({ ok: false, reason: "not_found" });
    });
  });

  describe("other shops", () => {
    test("another shop's folders and documents are never found", async () => {
      expect(await access.accessTo(owner, { folderId: folder.other })).toBe(
        null
      );
      expect(await access.accessTo(owner, { sourceId: doc.other })).toBe(null);
      expect((await visible(owner)).has(doc.other)).toBe(false);
    });

    test("HR in this shop is nobody in another shop, even as its admin", async () => {
      const elsewhere = await person("user_hr", "admin", otherOrgId);
      expect(await visible(elsewhere)).toEqual(new Set([doc.other]));
      expect(await access.accessTo(elsewhere, { sourceId: doc.payslips })).toBe(
        null
      );
    });
  });

  describe("a request can't choose its viewer", () => {
    test("someone who isn't an active member gets no viewer", async () => {
      expect(await viewers.viewerForMember(orgId, "user_stranger")).toBe(null);
      memberships.set(`${orgId}:user_left`, "planner");
      memberships.delete(`${orgId}:user_left`);
      expect(await viewers.viewerForMember(orgId, "user_left")).toBe(null);
    });

    test("an object shaped like a viewer is refused", async () => {
      const forged = {
        orgId,
        userId: "user_owner",
        role: "admin",
        isOwner: true,
        isAdmin: true,
        isSystem: false,
      };
      await expect(access.visibleSourceIds(forged)).rejects.toThrow(
        "Access checks need a viewer made on the server."
      );
      // A copy of a real one is just as untrusted.
      await expect(
        access.accessTo({ ...owner }, { folderId: folder.hr })
      ).rejects.toThrow();
    });

    test("a real viewer can't be edited", () => {
      expect(() => {
        (operator as { role: string | null }).role = "admin";
      }).toThrow(TypeError);
      expect(operator.role).toBe("operator");
    });

    test("departments and ownership come from the database, not the caller", async () => {
      // The SQL is told only shop, user and role; HR membership, ownership
      // and what a role may see are looked up.
      expect(
        (await visibleRaw(orgId, "user_hr", "member")).has(doc.payslips)
      ).toBe(true);
      expect(
        (await visibleRaw(orgId, "user_eng", "member")).has(doc.payslips)
      ).toBe(false);
      expect(
        (await visibleRaw(orgId, "user_owner", "admin")).has(doc.payslips)
      ).toBe(true);
      // The owner on record whose role was lowered isn't the owner (G3-F1).
      expect(
        (await visibleRaw(orgId, "user_owner", "member")).has(doc.payslips)
      ).toBe(false);
      expect(
        (await visibleRaw(orgId, "user_eng", "admin")).has(doc.payslips)
      ).toBe(false);
    });

    test("a user without a role, or a role without a user, sees nothing", async () => {
      expect(await visibleRaw(orgId, "user_hr", null)).toEqual(new Set());
      expect(await visibleRaw(orgId, null, "admin")).toEqual(new Set());
      // No user and no role is background work: shop-wide documents only.
      expect(await visibleRaw(orgId, null, null)).toEqual(
        new Set([doc.legacy, doc.handbook])
      );
    });
  });

  describe("changes apply on the next check", () => {
    test("joining and leaving a department", async () => {
      await database.departmentMember.create({
        data: { orgId, departmentId: dept.hr, userId: "user_operator" },
      });
      // The same viewer: departments are read again on every check.
      expect((await visible(operator)).has(doc.payslips)).toBe(true);
      await database.departmentMember.deleteMany({
        where: { departmentId: dept.hr, userId: "user_operator" },
      });
      expect((await visible(operator)).has(doc.payslips)).toBe(false);
    });

    test("removing a grant", async () => {
      const extra = await grant(
        { sourceId: doc.drawing },
        "user",
        "user_hr",
        VIEW
      );
      expect((await visible(hrPerson)).has(doc.drawing)).toBe(true);
      await database.accessGrant.delete({ where: { id: extra.id } });
      expect((await visible(hrPerson)).has(doc.drawing)).toBe(false);
    });

    test("deleting a department removes its grants", async () => {
      const temp = await database.department.create({
        data: { orgId, name: `Temp ${id().slice(0, 4)}` },
      });
      await grant({ folderId: folder.general }, "department", temp.id, ALL);
      await database.department.delete({ where: { id: temp.id } });
      expect(
        await database.accessGrant.count({
          where: { principalType: "department", principalId: temp.id },
        })
      ).toBe(0);
    });
  });

  describe("folder paths", () => {
    test("paths and depths come from the parent, not the app", async () => {
      const top = id();
      const child = id();
      await addFolder(top, `Top ${top.slice(0, 4)}`, null);
      await database.folder.create({
        data: {
          id: child,
          orgId,
          name: "Child",
          parentId: top,
          path: ["forged"],
          depth: 9,
        },
      });
      expect(
        await database.folder.findUniqueOrThrow({
          where: { id: child },
          select: { path: true, depth: true },
        })
      ).toEqual({ path: [top, child], depth: 2 });
    });

    test("moving a folder moves everything below it", async () => {
      const a = id();
      const b = id();
      const c = id();
      const target = id();
      await addFolder(a, `A ${a.slice(0, 4)}`, null);
      await addFolder(b, "B", a);
      await addFolder(c, "C", b);
      await addFolder(target, `Target ${target.slice(0, 4)}`, null);
      await database.folder.update({
        where: { id: b },
        data: { parentId: target },
      });
      expect(
        await database.folder.findUniqueOrThrow({
          where: { id: c },
          select: { path: true, depth: true },
        })
      ).toEqual({ path: [target, b, c], depth: 3 });
    });

    test("a folder can't move inside itself", async () => {
      const a = id();
      const b = id();
      await addFolder(a, `Loop ${a.slice(0, 4)}`, null);
      await addFolder(b, "Inner", a);
      await expect(
        database.folder.update({ where: { id: a }, data: { parentId: b } })
      ).rejects.toThrow();
    });

    test("two moves at once can't make a loop (A under B, B under A)", async () => {
      const a = id();
      const b = id();
      await addFolder(a, `Race A ${a.slice(0, 4)}`, null);
      await addFolder(b, `Race B ${b.slice(0, 4)}`, null);
      const pause = (seconds: number) =>
        database.$executeRawUnsafe(`select pg_sleep(${seconds})`);
      const results = await Promise.allSettled([
        database.$transaction(async (tx) => {
          await tx.folder.update({ where: { id: a }, data: { parentId: b } });
          await tx.$executeRawUnsafe("select pg_sleep(0.4)");
        }),
        pause(0.1).then(() =>
          database.folder.update({ where: { id: b }, data: { parentId: a } })
        ),
      ]);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const rows = await database.folder.findMany({
        where: { id: { in: [a, b] } },
        select: { id: true, path: true },
      });
      for (const row of rows) {
        // Its own ID appears once: at the end of its path.
        expect(row.path.filter((p) => p === row.id)).toHaveLength(1);
      }
    });

    test("a folder with documents in it can't be deleted on its own", async () => {
      await expect(
        database.folder.delete({ where: { id: folder.payroll } })
      ).rejects.toThrow();
    });
  });

  describe("the database refuses cross-shop links and bad grants", () => {
    test.each([
      [
        "a folder under another shop's folder",
        () => addFolder(id(), "Sneaky", folder.other),
      ],
      [
        "a document in another shop's folder",
        () => addDoc(id(), "Sneaky", folder.other),
      ],
      [
        "a grant on another shop's folder",
        () => grant({ folderId: folder.other }, "everyone", "", ALL),
      ],
      [
        "a grant naming another shop's department",
        async () => {
          const theirs = await database.department.create({
            data: { orgId: otherOrgId, name: `Theirs ${id().slice(0, 4)}` },
          });
          return grant(
            { folderId: folder.general },
            "department",
            theirs.id,
            ALL
          );
        },
      ],
      [
        "a member of another shop's department",
        () =>
          database.departmentMember.create({
            data: {
              orgId: otherOrgId,
              departmentId: dept.hr,
              userId: "user_x",
            },
          }),
      ],
    ])("%s", async (_name, attempt) => {
      await expect(attempt()).rejects.toThrow();
    });

    test.each([
      ["no capabilities", { folderId: folder.general }, "user", "u1", 0],
      ["unknown bits", { folderId: folder.general }, "user", "u1", 64],
      [
        "an unknown principal",
        { folderId: folder.general },
        "team",
        "u1",
        VIEW,
      ],
      [
        "everyone with an ID",
        { folderId: folder.general },
        "everyone",
        "x",
        VIEW,
      ],
      ["a user without an ID", { folderId: folder.general }, "user", "", VIEW],
    ])("a grant with %s", async (_name, target, type, principal, caps) => {
      await expect(grant(target, type, principal, caps)).rejects.toThrow();
    });

    test("a grant on a folder and a document at once", async () => {
      await expect(
        database.accessGrant.create({
          data: {
            orgId,
            folderId: folder.general,
            sourceId: doc.handbook,
            principalType: "user",
            principalId: "u1",
            capabilities: VIEW,
          },
        })
      ).rejects.toThrow();
    });
  });

  test("deleting a shop removes its whole folder tree", async () => {
    const shop = `org_lib_gone_${id().slice(0, 8)}`;
    await database.org.create({ data: { id: shop, name: "Gone" } });
    const top = id();
    const sub = id();
    await addFolder(top, "Top", null, {}, shop);
    await addFolder(sub, "Sub", top, {}, shop);
    await addDoc(id(), "Doc", sub, {}, shop);
    await database.org.delete({ where: { id: shop } });
    expect(await database.folder.count({ where: { orgId: shop } })).toBe(0);
  });
});
