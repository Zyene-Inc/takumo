// @vitest-environment node
// Security audit regressions (Knowledge Hub phase 4), access to confidential
// folders: H1 (a confidential folder inside a normal one inherited access from
// it, so an admin could reach HR files) and M5 (turning on restricted access
// skipped a confidential folder whose name was taken). These are the
// auditor's exploit steps, asserting they now fail. Restricted access is
// switched off in code; these tests switch it on. Needs TEST_DATABASE_URL.
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

type Db = typeof import("@repo/database");

const { has } = await import("../lib/library/capabilities");
type Viewer = import("../lib/library/viewer").Viewer;
type Target = { folderId: string } | { sourceId: string };

const id = () => randomUUID();
const ALL = 63;
const EDITOR = 31;

describe.skipIf(!TEST_DATABASE_URL)(
  "security audit: confidential folders (H1, M5)",
  () => {
    const orgId = `org_audit_access_${id().slice(0, 8)}`;
    const otherOrg = `org_audit_turnon_${id().slice(0, 8)}`;
    let database: Db["database"];
    let grants: typeof import("../lib/library/grants");
    let departments: typeof import("../lib/library/departments");
    let access: typeof import("../lib/library/access");
    let viewers: typeof import("../lib/library/viewer");
    let folders: typeof import("../lib/library/folders");
    let restricted: typeof import("../lib/library/restricted");

    const f = {
      eng: id(),
      payroll: id(),
      archive: id(),
      board: id(),
      open: id(),
    };
    const doc = { payslip: id(), plan: id(), notes: id() };
    const hr = id();

    const as = async (org: string, userId: string): Promise<Viewer> => {
      const v = await viewers.viewerForMember(org, userId);
      if (!v) {
        throw new Error(`${userId} isn't a member`);
      }
      return v;
    };
    const caps = async (userId: string, target: Target) =>
      (await access.accessTo(await as(orgId, userId), target))?.capabilities ??
      0;
    /** Whether this person may view it. */
    const sees = async (userId: string, target: Target) =>
      has(await caps(userId, target), "view");

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      ({ database } = await import("@repo/database"));
      grants = await import("../lib/library/grants");
      departments = await import("../lib/library/departments");
      access = await import("../lib/library/access");
      viewers = await import("../lib/library/viewer");
      folders = await import("../lib/library/folders");
      restricted = await import("../lib/library/restricted");
      for (const org of [orgId, otherOrg]) {
        for (const [user, role] of [
          ["u_owner", "admin"],
          ["u_admin", "admin"],
          ["u_hr", "member"],
          ["u_eng", "planner"],
          ["u_op", "operator"],
        ]) {
          members.set(`${org}:${user}`, role);
        }
      }
      await database.org.create({
        data: {
          id: orgId,
          name: "Audit",
          ownerUserId: "u_owner",
          libraryStage: "confidential",
        },
      });
      await database.department.create({
        data: { id: hr, orgId, name: "People team" },
      });
      await database.departmentMember.create({
        data: { orgId, departmentId: hr, userId: "u_hr" },
      });
      // Engineering (company-wide) with Payroll inside it; Archive and Board at
      // the top; Open (company-wide) for the move-out case.
      await database.folder.create({
        data: { id: f.eng, orgId, name: "Engineering" },
      });
      await database.folder.create({
        data: { id: f.open, orgId, name: "Open" },
      });
      await database.accessGrant.createMany({
        data: [f.eng, f.open].map((folderId) => ({
          orgId,
          folderId,
          principalType: "everyone",
          principalId: "",
          capabilities: 7,
        })),
      });
      await database.folder.create({
        data: { id: f.payroll, orgId, name: "Payroll", parentId: f.eng },
      });
      await database.folder.createMany({
        data: [
          { id: f.archive, orgId, name: "Archive" },
          { id: f.board, orgId, name: "Board" },
        ],
      });
      await database.source.createMany({
        data: [
          {
            id: doc.payslip,
            orgId,
            name: "ceo-payslip.pdf",
            folderId: f.payroll,
          },
          { id: doc.plan, orgId, name: "layoff-plan.pdf", folderId: f.board },
        ].map((s) => ({ ...s, type: "upload", profile: "document" })),
      });
    });

    afterAll(async () => {
      await database?.org.deleteMany({
        where: { id: { in: [orgId, otherOrg] } },
      });
    });

    test("H1: marking a nested folder confidential keeps today's access and stops inheritance", async () => {
      const owner = await as(orgId, "u_owner");
      expect(await grants.setConfidential(owner, f.payroll, true)).toEqual({
        ok: true,
      });
      expect(
        await grants.grantAccess(
          owner,
          { folderId: f.payroll },
          { type: "department", id: hr },
          EDITOR
        )
      ).toEqual({ ok: true });
      const folder = await database.folder.findUnique({
        where: { id: f.payroll },
        select: { inheritAccess: true, confidential: true },
      });
      expect(folder).toEqual({ inheritAccess: false, confidential: true });
      // The everyone grant Engineering had is copied, and in a confidential
      // folder it only allows uploading.
      expect(await sees("u_admin", { sourceId: doc.payslip })).toBe(false);
      expect(await sees("u_hr", { sourceId: doc.payslip })).toBe(true);
    });

    test("H1: an admin granting themselves on the folder above gets nothing inside", async () => {
      const admin = await as(orgId, "u_admin");
      expect(
        await grants.grantAccess(
          admin,
          { folderId: f.eng },
          { type: "user", id: "u_admin" },
          ALL
        )
      ).toEqual({ ok: true });
      expect(await sees("u_admin", { sourceId: doc.payslip })).toBe(false);
      expect(await sees("u_admin", { folderId: f.payroll })).toBe(false);
      // …so they can't pass access on either.
      const passOn = await grants.grantAccess(
        admin,
        { folderId: f.payroll },
        { type: "user", id: "u_op" },
        3
      );
      expect(passOn.ok).toBe(false);
      expect(await sees("u_op", { sourceId: doc.payslip })).toBe(false);
    });

    test("H1: a department given access on the folder above doesn't reach inside", async () => {
      const owner = await as(orgId, "u_owner");
      const admin = await as(orgId, "u_admin");
      const tooling = await departments.createDepartment(admin, "Tooling");
      if (!tooling.ok) {
        throw new Error(tooling.error);
      }
      await grants.grantAccess(
        owner,
        { folderId: f.eng },
        { type: "department", id: tooling.id },
        EDITOR
      );
      expect(
        await departments.addDepartmentMember(admin, tooling.id, "u_eng")
      ).toEqual({
        ok: true,
      });
      expect(await sees("u_eng", { sourceId: doc.payslip })).toBe(false);
    });

    test("H1: even with inheritance switched back on, a confidential folder inherits nothing", async () => {
      const owner = await as(orgId, "u_owner");
      expect(
        await grants.setInheritance(owner, { folderId: f.payroll }, true, {
          confirmed: true,
        })
      ).toEqual({ ok: true });
      expect(
        (
          await database.folder.findUnique({
            where: { id: f.payroll },
            select: { inheritAccess: true },
          })
        )?.inheritAccess
      ).toBe(true);
      // The admin's and Tooling's grants on Engineering still don't reach inside.
      expect(await sees("u_admin", { sourceId: doc.payslip })).toBe(false);
      expect(await sees("u_eng", { sourceId: doc.payslip })).toBe(false);
      expect(await sees("u_hr", { sourceId: doc.payslip })).toBe(true);
    });

    test("H1: a confidential folder moved under another folder doesn't inherit from it", async () => {
      const owner = await as(orgId, "u_owner");
      expect(await grants.setConfidential(owner, f.board, true)).toEqual({
        ok: true,
      });
      await grants.grantAccess(
        owner,
        { folderId: f.board },
        { type: "department", id: hr },
        EDITOR
      );
      expect((await folders.moveFolder(owner, f.board, f.archive)).ok).toBe(
        true
      );
      const admin = await as(orgId, "u_admin");
      await grants.grantAccess(
        owner,
        { folderId: f.archive },
        { type: "user", id: "u_admin" },
        ALL
      );
      await grants.grantAccess(
        owner,
        { folderId: f.archive },
        { type: "everyone" },
        EDITOR
      );
      expect(
        (await access.accessTo(admin, { sourceId: doc.plan }))?.capabilities ??
          0
      ).toBe(0);
      expect(await sees("u_op", { sourceId: doc.plan })).toBe(false);
      expect(await sees("u_hr", { sourceId: doc.plan })).toBe(true);
    });

    test("H1: moving a folder out of a confidential one doesn't widen access", async () => {
      const owner = await as(orgId, "u_owner");
      const made = await folders.createFolder(owner, f.payroll, "Slips");
      if (!made.ok) {
        throw new Error(made.error);
      }
      await database.source.create({
        data: {
          id: doc.notes,
          orgId,
          name: "slip-notes.pdf",
          type: "upload",
          profile: "document",
          folderId: made.id,
        },
      });
      expect(await sees("u_op", { sourceId: doc.notes })).toBe(false);
      expect((await folders.moveFolder(owner, made.id, f.open)).ok).toBe(true);
      // Open is company-wide, but Slips kept its own copy: the everyone grant
      // it carried from Payroll still only allows uploading.
      expect(await sees("u_op", { sourceId: doc.notes })).toBe(false);
      expect(await sees("u_hr", { sourceId: doc.notes })).toBe(true);
    });

    test("M5: turning on restricted access refuses while a top-level folder is called HR", async () => {
      await database.org.create({
        data: {
          id: otherOrg,
          name: "Audit 2",
          ownerUserId: "u_owner",
          libraryStage: "library",
        },
      });
      const existing = await database.folder.create({
        data: { id: id(), orgId: otherOrg, name: "HR" },
      });
      const owner = await as(otherOrg, "u_owner");
      const refused = await restricted.turnOnRestrictedAccess(owner);
      expect(refused.ok).toBe(false);
      expect(refused.ok ? "" : refused.error).toContain('"HR"');
      expect(
        (
          await database.org.findUnique({
            where: { id: otherOrg },
            select: { libraryStage: true },
          })
        )?.libraryStage
      ).toBe("library");
      // After renaming it, turning on makes a confidential HR folder.
      await database.folder.update({
        where: { id: existing.id },
        data: { name: "HR (old)" },
      });
      expect(await restricted.turnOnRestrictedAccess(owner)).toEqual({
        ok: true,
      });
      const made = await database.folder.findFirst({
        where: { orgId: otherOrg, systemKey: "hr" },
        select: { confidential: true, inheritAccess: true },
      });
      expect(made).toEqual({ confidential: true, inheritAccess: false });
    });
  }
);
