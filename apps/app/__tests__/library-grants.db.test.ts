// @vitest-environment node
// Changing access in the Company Knowledge Hub, against a real database: who
// may grant what, confidential folders, inheritance, departments and
// ownership. Restricting access is switched off in code until every AI path
// enforces it; these tests switch it on to check the rules behind it, and
// check that it really is off. Runs only with TEST_DATABASE_URL.
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

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

vi.mock("server-only", () => ({}));
vi.mock("../../../packages/database/node_modules/server-only", () => ({}));

// Active members of the test shop (WorkOS is mocked).
const members = new Map<string, string>();
vi.mock("@repo/auth/server", () => ({
  auth: vi.fn(),
  shopRole: async (userId: string) => members.get(userId) ?? null,
}));
const stage = { enabled: true };
vi.mock("../lib/library/stage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confidentialEnabled: async () => stage.enabled,
}));

type Db = typeof import("@repo/database");
type Viewer = import("../lib/library/viewer").Viewer;

const ALL = 63;
const VIEW = 1;
const UPLOAD = 4;
const VIEWER = 3;
const EDITOR = 31;
const MANAGE_AND_VIEW = 33;

const id = () => randomUUID();

describe.skipIf(!TEST_DATABASE_URL)(
  "changing knowledge hub access (database)",
  () => {
    const orgId = `org_grants_${id().slice(0, 8)}`;
    let database: Db["database"];
    let grants: typeof import("../lib/library/grants");
    let departments: typeof import("../lib/library/departments");
    let ownership: typeof import("../lib/library/ownership");
    let access: typeof import("../lib/library/access");
    let viewers: typeof import("../lib/library/viewer");

    const hr = id();
    const folder = {
      engineering: id(),
      drawings: id(),
      hr: id(),
      general: id(),
    };
    const legacyDoc = id();

    // Made the only way the app can: membership and role from (mocked) WorkOS.
    const viewerFor = async (userId: string) => {
      const viewer = await viewers.viewerForMember(orgId, userId);
      if (!viewer) {
        throw new Error(`${userId} isn't a member`);
      }
      return viewer;
    };

    const caps = async (
      viewer: Viewer,
      target: { folderId: string } | { sourceId: string }
    ) => (await access.accessTo(viewer, target))?.capabilities ?? 0;

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      process.env.SKIP_ENV_VALIDATION = "true";
      ({ database } = await import("@repo/database"));
      grants = await import("../lib/library/grants");
      departments = await import("../lib/library/departments");
      ownership = await import("../lib/library/ownership");
      access = await import("../lib/library/access");
      viewers = await import("../lib/library/viewer");

      for (const [user, role] of [
        ["user_owner", "admin"],
        ["user_admin", "admin"],
        ["user_eng", "planner"],
        ["user_hr", "member"],
        ["user_op", "operator"],
      ]) {
        members.set(user, role);
      }
      await database.org.create({
        data: { id: orgId, name: "Grants test", ownerUserId: "user_owner" },
      });
      await database.department.create({ data: { id: hr, orgId, name: "HR" } });
      await database.departmentMember.create({
        data: { orgId, departmentId: hr, userId: "user_hr" },
      });
      await database.folder.createMany({
        data: [
          { id: folder.engineering, orgId, name: "Engineering" },
          {
            id: folder.hr,
            orgId,
            name: "HR",
            confidential: true,
            inheritAccess: false,
          },
          { id: folder.general, orgId, name: "General" },
        ],
      });
      await database.folder.create({
        data: {
          id: folder.drawings,
          orgId,
          name: "Drawings",
          parentId: folder.engineering,
        },
      });
      await database.accessGrant.createMany({
        data: [
          {
            orgId,
            folderId: folder.engineering,
            principalType: "user",
            principalId: "user_eng",
            capabilities: MANAGE_AND_VIEW,
          },
          {
            orgId,
            folderId: folder.hr,
            principalType: "department",
            principalId: hr,
            capabilities: EDITOR,
          },
        ],
      });
      await database.source.create({
        data: {
          id: legacyDoc,
          orgId,
          name: "Old SOP",
          type: "upload",
          profile: "document",
        },
      });
    });

    beforeEach(() => {
      stage.enabled = true;
    });

    afterAll(async () => {
      await database?.org.deleteMany({ where: { id: orgId } });
    });

    describe("while restricted access is switched off", () => {
      test("nothing can be granted, restricted or reorganised", async () => {
        stage.enabled = false;
        const owner = await viewerFor("user_owner");
        const before = await database.accessGrant.count({ where: { orgId } });
        const attempts = await Promise.all([
          grants.grantAccess(
            owner,
            { folderId: folder.general },
            { type: "everyone" },
            VIEWER
          ),
          grants.setInheritance(owner, { folderId: folder.drawings }, false),
          grants.setConfidential(owner, folder.general, true),
          departments.createDepartment(owner, "Finance"),
          departments.addDepartmentMember(owner, hr, "user_op"),
        ]);
        for (const result of attempts) {
          expect(result).toEqual({
            ok: false,
            error: "Restricting who can see documents isn't available yet.",
          });
        }
        expect(await database.accessGrant.count({ where: { orgId } })).toBe(
          before
        );
        expect(await database.department.count({ where: { orgId } })).toBe(1);
      });

      test("the real switch is off for every shop", async () => {
        const real = await vi.importActual<
          typeof import("../lib/library/stage")
        >("../lib/library/stage");
        await database.org.update({
          where: { id: orgId },
          data: { libraryStage: "confidential" },
        });
        expect(await real.confidentialEnabled(orgId)).toBe(false);
        await database.org.update({
          where: { id: orgId },
          data: { libraryStage: "off" },
        });
      });
    });

    describe("granting", () => {
      test("only someone who manages a folder may change its access", async () => {
        const op = await viewerFor("user_op");
        expect(
          await grants.grantAccess(
            op,
            { folderId: folder.engineering },
            { type: "user", id: "user_op" },
            VIEW
          )
        ).toMatchObject({ ok: false });
      });

      test("a manager can't give more than they have", async () => {
        const eng = await viewerFor("user_eng");
        expect(
          await grants.grantAccess(
            eng,
            { folderId: folder.engineering },
            { type: "user", id: "user_op" },
            ALL
          )
        ).toEqual({
          ok: false,
          error: "You can only give access you have yourself.",
        });
        expect(
          await grants.grantAccess(
            eng,
            { folderId: folder.engineering },
            { type: "user", id: "user_op" },
            VIEW
          )
        ).toEqual({ ok: true });
        expect(
          await caps(await viewerFor("user_op"), { folderId: folder.drawings })
        ).toBe(VIEW);
      });

      test("download without view is refused", async () => {
        const owner = await viewerFor("user_owner");
        expect(
          await grants.grantAccess(
            owner,
            { folderId: folder.general },
            { type: "user", id: "user_op" },
            2
          )
        ).toMatchObject({ ok: false });
      });

      test("in a confidential folder, everyone may only be allowed to upload", async () => {
        const owner = await viewerFor("user_owner");
        expect(
          await grants.grantAccess(
            owner,
            { folderId: folder.hr },
            { type: "everyone" },
            VIEWER
          )
        ).toMatchObject({ ok: false });
        expect(
          await grants.grantAccess(
            owner,
            { folderId: folder.hr },
            { type: "role", id: "admin" },
            VIEWER
          )
        ).toMatchObject({ ok: false });
        expect(
          await grants.grantAccess(
            owner,
            { folderId: folder.hr },
            { type: "everyone" },
            UPLOAD
          )
        ).toEqual({ ok: true });
      });

      test("an admin can't change access to a confidential folder", async () => {
        const admin = await viewerFor("user_admin");
        expect(
          await grants.grantAccess(
            admin,
            { folderId: folder.hr },
            { type: "user", id: "user_admin" },
            VIEWER
          )
        ).toMatchObject({ ok: false });
        expect(await caps(admin, { folderId: folder.hr })).toBe(UPLOAD);
      });

      test("revoking: the owner can, someone without manage can't", async () => {
        const owner = await viewerFor("user_owner");
        await grants.grantAccess(
          owner,
          { folderId: folder.general },
          { type: "user", id: "user_hr" },
          VIEWER
        );
        const grant = await database.accessGrant.findFirstOrThrow({
          where: { folderId: folder.general, principalId: "user_hr" },
        });
        expect(
          await grants.revokeAccess(await viewerFor("user_op"), grant.id)
        ).toMatchObject({
          ok: false,
        });
        expect(await grants.revokeAccess(owner, grant.id)).toEqual({
          ok: true,
        });
        expect(await grants.revokeAccess(owner, grant.id)).toMatchObject({
          ok: false,
        });
      });
    });

    describe("inheritance", () => {
      test("stopping copies what was inherited, so nobody loses access", async () => {
        const owner = await viewerFor("user_owner");
        const eng = await viewerFor("user_eng");
        const before = await caps(eng, { folderId: folder.drawings });
        expect(
          await grants.setInheritance(
            owner,
            { folderId: folder.drawings },
            false
          )
        ).toEqual({
          ok: true,
        });
        expect(await caps(eng, { folderId: folder.drawings })).toBe(before);
        const copied = await database.accessGrant.findFirstOrThrow({
          where: { folderId: folder.drawings, principalId: "user_eng" },
        });
        // Removing the copy is the deliberate step that restricts it.
        await database.accessGrant.delete({ where: { id: copied.id } });
        expect(await caps(eng, { folderId: folder.drawings })).toBe(0);
        // Resuming gives access back to more people: it's confirmed first.
        expect(
          await grants.setInheritance(
            owner,
            { folderId: folder.drawings },
            true
          )
        ).toMatchObject({ ok: false, confirm: [expect.anything()] });
        expect(await caps(eng, { folderId: folder.drawings })).toBe(0);
        expect(
          await grants.setInheritance(
            owner,
            { folderId: folder.drawings },
            true,
            { confirmed: true }
          )
        ).toEqual({
          ok: true,
        });
        expect(await caps(eng, { folderId: folder.drawings })).toBe(before);
      });

      test("a document from before folders keeps everyone's reading when it stops inheriting", async () => {
        const owner = await viewerFor("user_owner");
        await grants.setInheritance(owner, { sourceId: legacyDoc }, false);
        expect(
          await caps(await viewerFor("user_op"), { sourceId: legacyDoc })
        ).toBe(VIEWER);
      });
    });

    describe("confidential folders", () => {
      test("only the owner marks a folder confidential, and admins then lose it", async () => {
        const admin = await viewerFor("user_admin");
        const owner = await viewerFor("user_owner");
        expect(
          await grants.setConfidential(admin, folder.general, true)
        ).toMatchObject({
          ok: false,
        });
        expect(await caps(admin, { folderId: folder.general })).toBe(ALL);
        expect(
          await grants.setConfidential(owner, folder.general, true)
        ).toEqual({ ok: true });
        expect(await caps(admin, { folderId: folder.general })).toBe(0);
        await grants.setConfidential(owner, folder.general, false);
      });
    });

    describe("departments", () => {
      test("admins create departments; operators can't", async () => {
        expect(
          await departments.createDepartment(
            await viewerFor("user_op"),
            "Sales"
          )
        ).toMatchObject({ ok: false });
        const made = await departments.createDepartment(
          await viewerFor("user_admin"),
          "  Sales  "
        );
        expect(made).toMatchObject({ ok: true });
        expect(
          await departments.createDepartment(
            await viewerFor("user_admin"),
            "Sales"
          )
        ).toMatchObject({ ok: false });
      });

      test("only active members join a department", async () => {
        expect(
          await departments.addDepartmentMember(
            await viewerFor("user_owner"),
            hr,
            "user_gone"
          )
        ).toEqual({
          ok: false,
          error: "They need to be in the shop before joining a department.",
        });
      });

      test("an admin can't add themselves to HR to read confidential files", async () => {
        const admin = await viewerFor("user_admin");
        expect(
          await departments.addDepartmentMember(admin, hr, "user_admin")
        ).toMatchObject({
          ok: false,
        });
        expect(await departments.deleteDepartment(admin, hr)).toMatchObject({
          ok: false,
        });
        expect(
          await caps(await viewerFor("user_admin"), { folderId: folder.hr })
        ).toBe(UPLOAD);
      });

      test("the owner can, and it applies on the next check", async () => {
        const owner = await viewerFor("user_owner");
        expect(
          await departments.addDepartmentMember(owner, hr, "user_op")
        ).toEqual({ ok: true });
        expect(
          await caps(await viewerFor("user_op"), { folderId: folder.hr })
        ).toBe(EDITOR);
        expect(
          await departments.removeDepartmentMember(owner, hr, "user_op")
        ).toEqual({
          ok: true,
        });
        expect(
          await caps(await viewerFor("user_op"), { folderId: folder.hr })
        ).toBe(UPLOAD);
      });
    });

    describe("ownership", () => {
      test("only the owner hands over, only to a member, and only once", async () => {
        const admin = await viewerFor("user_admin");
        expect(
          await ownership.transferOwnership(admin, "user_admin")
        ).toMatchObject({ ok: false });
        const owner = await viewerFor("user_owner");
        expect(
          await ownership.transferOwnership(owner, "user_gone")
        ).toMatchObject({ ok: false });
        expect(await ownership.transferOwnership(owner, "user_admin")).toEqual({
          ok: true,
        });
        // The old owner's stale viewer can't hand it on again.
        expect(
          await ownership.transferOwnership(owner, "user_eng")
        ).toMatchObject({ ok: false });
        const newOwner = await viewerFor("user_admin");
        expect(newOwner.isOwner).toBe(true);
        expect(await caps(newOwner, { folderId: folder.hr })).toBe(ALL);
        expect((await viewerFor("user_owner")).isOwner).toBe(false);
      });

      test("recording the creator never replaces an existing owner", async () => {
        await ownership.recordShopOwner(orgId, "user_eng");
        const org = await database.org.findUniqueOrThrow({
          where: { id: orgId },
        });
        expect(org.ownerUserId).toBe("user_admin");
      });
    });
  }
);
