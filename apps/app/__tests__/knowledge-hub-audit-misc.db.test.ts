// @vitest-environment node
// Security audit regressions (Knowledge Hub phase 4), smaller authorization
// findings: L3 (an owner removed and invited back with a lesser role kept
// owner powers), L7 (a former editor could retry a failed version, which can
// then become current) and L11 (a row could be moved to another shop).
// Restricted access is switched off in code; these tests switch it on.
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

// Active WorkOS memberships, "shop:user" → role, and who is signed in.
const members = new Map<string, string>();
const session: { orgId?: string; userId?: string } = {};
vi.mock("@repo/auth/server", () => ({
  auth: async () => ({
    ...session,
    role: members.get(`${session.orgId}:${session.userId}`),
  }),
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

const id = () => randomUUID();
const VIEWER = 3;
const CONTRIBUTOR = 7;

describe.skipIf(!TEST_DATABASE_URL)(
  "security audit: authorization (L3, L7, L11)",
  () => {
    const orgId = `org_audit_misc_${id().slice(0, 8)}`;
    const otherOrg = `org_audit_misc2_${id().slice(0, 8)}`;
    let database: Db["database"];
    let viewers: typeof import("../lib/library/viewer");
    let actions: typeof import("../app/(authenticated)/knowledge/actions");
    const folderId = id();
    const sourceId = id();
    const versionId = id();

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      ({ database } = await import("@repo/database"));
      viewers = await import("../lib/library/viewer");
      actions = await import("../app/(authenticated)/knowledge/actions");
      members.set(`${orgId}:u_owner`, "admin");
      members.set(`${orgId}:u_former`, "member");
      await database.org.createMany({
        data: [
          {
            id: orgId,
            name: "Audit",
            ownerUserId: "u_owner",
            libraryStage: "confidential",
          },
          {
            id: otherOrg,
            name: "Other",
            ownerUserId: "u_other",
            libraryStage: "library",
          },
        ],
      });
      await database.folder.create({
        data: { id: folderId, orgId, name: "Drawings" },
      });
      await database.accessGrant.create({
        data: {
          orgId,
          folderId,
          principalType: "everyone",
          principalId: "",
          capabilities: VIEWER,
        },
      });
      await database.source.create({
        data: {
          id: sourceId,
          orgId,
          name: "fixture.pdf",
          type: "upload",
          profile: "document",
          folderId,
          uploadedBy: "u_former",
        },
      });
      await database.documentVersion.create({
        data: {
          id: versionId,
          orgId,
          sourceId,
          number: 1,
          name: "fixture.pdf",
          uploadedBy: "u_former",
          status: "failed",
        },
      });
    });

    afterAll(async () => {
      await database?.org.deleteMany({
        where: { id: { in: [orgId, otherOrg] } },
      });
    });

    test("L3: the owner on record invited back with a lesser role has no owner powers", async () => {
      members.set(`${orgId}:u_owner`, "operator");
      expect((await viewers.viewerForMember(orgId, "u_owner"))?.isOwner).toBe(
        false
      );
      members.set(`${orgId}:u_owner`, "admin");
      expect((await viewers.viewerForMember(orgId, "u_owner"))?.isOwner).toBe(
        true
      );
    });

    test("L7: a former editor who can now only view can't retry their failed version", async () => {
      Object.assign(session, { orgId, userId: "u_former" });
      const refused = await actions.retryVersion(sourceId, versionId);
      expect(refused.ok).toBe(false);
      const still = await database.documentVersion.findUnique({
        where: { id: versionId },
        select: { status: true },
      });
      expect(still?.status).toBe("failed");
    });

    test("L7: while they may still upload there, they can retry their own upload", async () => {
      await database.accessGrant.create({
        data: {
          orgId,
          folderId,
          principalType: "user",
          principalId: "u_former",
          capabilities: CONTRIBUTOR,
        },
      });
      Object.assign(session, { orgId, userId: "u_former" });
      expect(await actions.retryVersion(sourceId, versionId)).toEqual({
        ok: true,
      });
      const queued = await database.documentVersion.findUnique({
        where: { id: versionId },
        select: { status: true },
      });
      expect(queued?.status).toBe("queued");
    });

    test("L11: a folder, document, grant, version or department can't be moved to another shop", async () => {
      const department = await database.department.create({
        data: { orgId, name: "Purchasing" },
      });
      const moves = [
        () =>
          database.department.update({
            where: { id: department.id },
            data: { orgId: otherOrg },
          }),
        () =>
          database.folder.update({
            where: { id: folderId },
            data: { orgId: otherOrg },
          }),
        () =>
          database.source.update({
            where: { id: sourceId },
            data: { orgId: otherOrg },
          }),
        () =>
          database.documentVersion.update({
            where: { id: versionId },
            data: { orgId: otherOrg },
          }),
        () =>
          database.accessGrant.updateMany({
            where: { orgId, folderId },
            data: { orgId: otherOrg },
          }),
      ];
      for (const move of moves) {
        await expect(move()).rejects.toThrow();
      }
      const where = { where: { orgId: otherOrg } };
      expect(
        await Promise.all([
          database.folder.count(where),
          database.source.count(where),
          database.documentVersion.count(where),
          database.accessGrant.count(where),
          database.department.count(where),
        ])
      ).toEqual([0, 0, 0, 0, 0]);
    });
  }
);
