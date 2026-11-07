// @vitest-environment node
// The Knowledge Hub's viewer (who is asking) and capability rules, without a
// database: a viewer only exists for an active member, owner and admin are
// told apart, and grants are checked before anything is written.
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

const session = vi.hoisted(() => ({
  value: { orgId: "org_1", userId: "user_1", role: "planner" } as {
    orgId: string | null;
    role: string | null;
    userId: string | null;
  },
}));
const shopRole = vi.hoisted(() => vi.fn());
vi.mock("@repo/auth/server", () => ({
  auth: async () => session.value,
  shopRole,
}));

const db = vi.hoisted(() => ({
  org: { findUnique: vi.fn() },
}));
vi.mock("@repo/database", () => ({
  database: db,
  forOrg: () => db,
}));

const { resolveViewer, systemViewer, trustedViewer, viewerForMember } =
  await import("../lib/library/viewer");
const { capabilitiesProblem, combine, covers, has, PRESETS } = await import(
  "../lib/library/capabilities"
);
const { grantProblem } = await import("../lib/library/grants");
const { confidentialEnabled } = await import("../lib/library/stage");

describe("viewer", () => {
  beforeEach(() => {
    session.value = { orgId: "org_1", userId: "user_1", role: "planner" };
    db.org.findUnique
      .mockReset()
      .mockResolvedValue({ ownerUserId: "user_owner" });
    shopRole.mockReset();
  });

  test("a signed-in member gets a frozen viewer with their shop, user and role", async () => {
    const viewer = await resolveViewer();
    expect(viewer).toEqual({
      orgId: "org_1",
      userId: "user_1",
      role: "planner",
      isOwner: false,
      isAdmin: false,
      isSystem: false,
    });
    expect(Object.isFrozen(viewer)).toBe(true);
    expect(viewer && trustedViewer(viewer)).toBe(viewer);
  });

  test("someone signed in but no longer an active member has no viewer", async () => {
    session.value = { orgId: "org_1", userId: "user_1", role: null };
    expect(await resolveViewer()).toBe(null);
    expect(db.org.findUnique).not.toHaveBeenCalled();
  });

  test("no shop chosen, or the shop is gone: no viewer", async () => {
    session.value = { orgId: null, userId: "user_1", role: null };
    expect(await resolveViewer()).toBe(null);
    session.value = { orgId: "org_gone", userId: "user_1", role: "admin" };
    db.org.findUnique.mockResolvedValue(null);
    expect(await resolveViewer()).toBe(null);
  });

  test("the owner is the recorded user, whatever their WorkOS role", async () => {
    session.value = { orgId: "org_1", userId: "user_owner", role: "planner" };
    expect((await resolveViewer())?.isOwner).toBe(true);
    session.value = { orgId: "org_1", userId: "user_2", role: "admin" };
    expect((await resolveViewer())?.isOwner).toBe(false);
    db.org.findUnique.mockResolvedValue({ ownerUserId: null });
    expect((await resolveViewer())?.isOwner).toBe(false);
  });

  test("admins are the admin and owner role slugs only", async () => {
    for (const [role, admin] of [
      ["admin", true],
      ["owner", true],
      ["planner", false],
      ["estimator", false],
      ["operator", false],
      ["member", false],
    ] as const) {
      session.value = { orgId: "org_1", userId: "user_1", role };
      expect((await resolveViewer())?.isAdmin).toBe(admin);
    }
  });

  test("a member who isn't signed in here: role read from WorkOS, not given", async () => {
    shopRole.mockResolvedValue("estimator");
    expect(await viewerForMember("org_1", "user_9")).toMatchObject({
      userId: "user_9",
      role: "estimator",
    });
    expect(shopRole).toHaveBeenCalledWith("user_9", "org_1");
    shopRole.mockResolvedValue(null);
    expect(await viewerForMember("org_1", "user_gone")).toBe(null);
  });

  test("only viewers made here are trusted", async () => {
    const real = await resolveViewer();
    if (!real) {
      throw new Error("expected a viewer");
    }
    expect(() => trustedViewer({ ...real })).toThrow(
      "Access checks need a viewer made on the server."
    );
    expect(() =>
      trustedViewer(JSON.parse(JSON.stringify(real)) as typeof real)
    ).toThrow();
  });

  test("background work has no user or role", () => {
    const viewer = systemViewer("org_1");
    expect(viewer).toMatchObject({
      userId: null,
      role: null,
      isOwner: false,
      isAdmin: false,
      isSystem: true,
    });
    expect(trustedViewer(viewer)).toBe(viewer);
  });
});

describe("capabilities", () => {
  test("each capability is its own bit", () => {
    expect(has(PRESETS.viewer, "view")).toBe(true);
    expect(has(PRESETS.viewer, "download")).toBe(true);
    expect(has(PRESETS.viewer, "edit")).toBe(false);
    expect(has(PRESETS.dropBox, "view")).toBe(false);
    expect(covers(PRESETS.editor, PRESETS.viewer)).toBe(true);
    expect(covers(PRESETS.viewer, PRESETS.editor)).toBe(false);
    expect(combine(PRESETS.viewer, PRESETS.dropBox)).toBe(PRESETS.contributor);
  });

  test.each([
    [0, false],
    [64, false],
    [1.5, false],
    [2, false], // download without view
    [8, false], // edit without view
    [4, true], // upload only: a drop box
    [3, true],
    [63, true],
  ])("%s is %s", (capabilities, ok) => {
    expect(capabilitiesProblem(capabilities) === null).toBe(ok);
  });
});

describe("grant rules", () => {
  const manager = { capabilities: 63, confidential: false };

  test("nobody but the owner gives more than they hold", () => {
    expect(
      grantProblem({
        viewer: { isOwner: false },
        access: {
          capabilities: combine(PRESETS.contributor, 32),
          confidential: false,
        },
        principal: { type: "user", id: "u" },
        capabilities: PRESETS.editor,
      })
    ).toBe("You can only give access you have yourself.");
    expect(
      grantProblem({
        viewer: { isOwner: true },
        access: { capabilities: 32, confidential: false },
        principal: { type: "user", id: "u" },
        capabilities: PRESETS.editor,
      })
    ).toBe(null);
  });

  test("confidential folders: whole groups may only upload", () => {
    const confidential = { ...manager, confidential: true };
    for (const principal of [
      { type: "everyone" } as const,
      { type: "role", id: "admin" } as const,
    ]) {
      expect(
        grantProblem({
          viewer: { isOwner: true },
          access: confidential,
          principal,
          capabilities: PRESETS.viewer,
        })
      ).toMatch(/may only upload/);
      expect(
        grantProblem({
          viewer: { isOwner: true },
          access: confidential,
          principal,
          capabilities: PRESETS.dropBox,
        })
      ).toBe(null);
    }
    expect(
      grantProblem({
        viewer: { isOwner: true },
        access: confidential,
        principal: { type: "department", id: "d_hr" },
        capabilities: PRESETS.editor,
      })
    ).toBe(null);
  });
});

test("restricted access is off in this release, whatever the shop's stage", async () => {
  db.org.findUnique.mockClear().mockResolvedValue({
    libraryStage: "confidential",
  });
  expect(await confidentialEnabled("org_1")).toBe(false);
  expect(db.org.findUnique).not.toHaveBeenCalled();
});
