// @vitest-environment node
// Someone removed from a shop in WorkOS whose browser session still names it
// (until the session refreshes) must not reach the shop's data: auth() names
// a shop only while the WorkOS membership is active, and the routes that
// trust auth()'s shop (file downloads, the AI chat) turn them away. The real
// auth() runs here; only WorkOS is mocked.
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../../../packages/auth/node_modules/server-only", () => ({}));
vi.mock("../../../packages/analytics/node_modules/server-only", () => ({}));
vi.mock("../../../packages/engine-client/node_modules/server-only", () => ({}));
vi.mock("../../../packages/payments/node_modules/server-only", () => ({}));

const workos = vi.hoisted(() => ({
  session: {
    user: { id: "user_eng" } as { id: string } | null,
    organizationId: "org_shop" as string | undefined,
  },
  // Active memberships, as WorkOS lists them.
  active: [] as { role: { slug: string } }[],
}));
vi.mock(
  "../../../packages/auth/node_modules/@workos-inc/authkit-nextjs",
  () => ({
    withAuth: async () => workos.session,
    getWorkOS: () => ({
      userManagement: {
        listOrganizationMemberships: async () => ({ data: workos.active }),
      },
    }),
    getSignInUrl: vi.fn(),
    getSignUpUrl: vi.fn(),
    handleAuth: vi.fn(),
    signOut: vi.fn(),
    switchToOrganization: vi.fn(),
  })
);

// Nothing below may be reached by someone who isn't a member.
const reached = vi.hoisted(() => vi.fn());
vi.mock("../lib/quotes/files", () => ({
  rfqFileBytes: (...args: unknown[]) => reached("rfqFileBytes", ...args),
}));
vi.mock("@repo/database", () => ({
  database: new Proxy({}, { get: (_t, model) => reached("database", model) }),
  forOrg: (...args: unknown[]) => reached("forOrg", ...args),
}));
vi.mock("../lib/agent/agent", () => ({ agentSettings: reached }));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The AI route's imports read the app's settings; none are needed here.
process.env.SKIP_ENV_VALIDATION = "true";

const { auth } = await import("@repo/auth/server");
const { authorize } = await import("../lib/access");
const { resolveViewer } = await import("../lib/library/viewer");
const rfqFile = await import(
  "../app/(authenticated)/quotes/[id]/files/[fileId]/route"
);
const poFile = await import(
  "../app/(authenticated)/orders/incoming/[id]/files/[fileId]/route"
);
const ask = await import("../app/api/ask/route");

const params = Promise.resolve({ id: "rfq_1", fileId: "file_1" });

describe("membership ended in WorkOS, session still open", () => {
  beforeEach(() => {
    workos.session = { user: { id: "user_eng" }, organizationId: "org_shop" };
    workos.active = [];
    reached.mockClear();
  });

  test("auth() no longer names the shop", async () => {
    expect(await auth()).toEqual({
      userId: "user_eng",
      orgId: null,
      role: null,
    });
  });

  test("an active member still gets their shop and role", async () => {
    workos.active = [{ role: { slug: "planner" } }];
    expect(await auth()).toEqual({
      userId: "user_eng",
      orgId: "org_shop",
      role: "planner",
    });
  });

  test("an RFQ file download is not found", async () => {
    const response = await rfqFile.GET(
      new Request("http://test/quotes/rfq_1/files/file_1"),
      { params }
    );
    expect(response.status).toBe(404);
    expect(reached).not.toHaveBeenCalled();
  });

  test("a customer PO file download is not found", async () => {
    const response = await poFile.GET(
      new Request("http://test/orders/incoming/po_1/files/file_1"),
      { params }
    );
    expect(response.status).toBe(404);
    expect(reached).not.toHaveBeenCalled();
  });

  test("the AI chat refuses before reading anything", async () => {
    const response = await ask.POST(
      new Request("http://test/api/ask", {
        method: "POST",
        body: JSON.stringify({
          id: "c1",
          message: { role: "user", parts: [] },
        }),
      })
    );
    expect(response.status).toBe(401);
    expect(reached).not.toHaveBeenCalled();
  });

  test("server actions are refused, whatever the permission", async () => {
    expect(await authorize("knowledge:share")).toEqual({
      ok: false,
      error: "Choose a shop first.",
    });
  });

  test("the Knowledge Hub gives them no viewer", async () => {
    expect(await resolveViewer()).toBe(null);
    expect(reached).not.toHaveBeenCalled();
  });
});
