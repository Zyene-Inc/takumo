import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";

const SECRET = "whsec_test_secret";

const database = vi.hoisted(() => ({
  org: {
    upsert: vi.fn(),
    deleteMany: vi.fn(),
    findUnique: vi.fn(),
  },
  member: {
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  departmentMember: { deleteMany: vi.fn() },
  accessGrant: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
}));

// The real WorkOS client, so signature verification is exercised. Imported
// from the auth package's copy, which pnpm doesn't link into apps/app.
vi.mock("@repo/auth/server", async () => {
  const { WorkOS } = await import(
    "../../../packages/auth/node_modules/@workos-inc/node"
  );
  const workos = new WorkOS("sk_test_webhook");
  return { getWorkOS: () => workos };
});
vi.mock("@repo/database", () => ({ database }));
vi.mock("@repo/analytics/server", () => ({ analytics: undefined }));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("@/env", () => ({ env: { WORKOS_WEBHOOK_SECRET: SECRET } }));

const { POST } = await import("../app/api/webhooks/auth/route");

// Signs the payload the way WorkOS does: "t=<ms>, v1=<hmac(t.payload)>".
const signedRequest = (payload: object, secret = SECRET) => {
  const body = JSON.stringify(payload);
  const timestamp = Date.now();
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return new Request("http://localhost/api/webhooks/auth", {
    method: "POST",
    headers: { "WorkOS-Signature": `t=${timestamp}, v1=${digest}` },
    body,
  });
};

const now = new Date().toISOString();

describe("WorkOS webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("rejects a request without a signature", async () => {
    const response = await POST(
      new Request("http://localhost/api/webhooks/auth", {
        method: "POST",
        body: "{}",
      })
    );
    expect(response.status).toBe(400);
  });

  test("rejects a request signed with the wrong secret", async () => {
    const response = await POST(
      signedRequest(
        { id: "event_1", event: "organization.created", data: {} },
        "wrong"
      )
    );
    expect(response.status).toBe(400);
    expect(database.org.upsert).not.toHaveBeenCalled();
  });

  test("organization.created upserts the Org row", async () => {
    const response = await POST(
      signedRequest({
        id: "event_2",
        event: "organization.created",
        created_at: now,
        data: {
          object: "organization",
          id: "org_123",
          name: "Acme Precision",
          allow_profiles_outside_organization: false,
          domains: [],
          created_at: now,
          updated_at: now,
        },
      })
    );
    expect(response.status).toBe(200);
    expect(database.org.upsert).toHaveBeenCalledWith({
      where: { id: "org_123" },
      create: {
        id: "org_123",
        name: "Acme Precision",
        trialEndsAt: expect.any(Date),
      },
      update: { name: "Acme Precision" },
    });
    // A 30-day trial.
    const created = database.org.upsert.mock.calls[0][0].create
      .trialEndsAt as Date;
    expect(Math.round((created.getTime() - Date.now()) / 86_400_000)).toBe(30);
  });

  test("organization_membership.created adds the Member row", async () => {
    database.org.findUnique.mockResolvedValue({ id: "org_123" });
    const response = await POST(
      signedRequest({
        id: "event_3",
        event: "organization_membership.created",
        created_at: now,
        data: {
          object: "organization_membership",
          id: "om_1",
          user_id: "user_1",
          organization_id: "org_123",
          status: "active",
          role: { slug: "member" },
          created_at: now,
          updated_at: now,
        },
      })
    );
    expect(response.status).toBe(200);
    expect(database.member.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { orgId: "org_123", userId: "user_1" },
      })
    );
  });

  test("organization_membership.deleted removes the Member row, departments and personal grants together", async () => {
    const response = await POST(
      signedRequest({
        id: "event_4",
        event: "organization_membership.deleted",
        created_at: now,
        data: {
          object: "organization_membership",
          id: "om_1",
          user_id: "user_1",
          organization_id: "org_123",
          status: "inactive",
          role: { slug: "member" },
          created_at: now,
          updated_at: now,
        },
      })
    );
    expect(response.status).toBe(200);
    expect(database.member.deleteMany).toHaveBeenCalledWith({
      where: { orgId: "org_123", userId: "user_1" },
    });
    expect(database.departmentMember.deleteMany).toHaveBeenCalledWith({
      where: { orgId: "org_123", userId: "user_1" },
    });
    expect(database.accessGrant.deleteMany).toHaveBeenCalledWith({
      where: { orgId: "org_123", principalType: "user", principalId: "user_1" },
    });
    // All three in one transaction.
    expect(database.$transaction).toHaveBeenCalledTimes(1);
    expect(database.$transaction.mock.calls[0]?.[0]).toHaveLength(3);
  });
});
