import { beforeEach, describe, expect, test, vi } from "vitest";

const SECRET = "whsec_test_payments";

const database = vi.hoisted(() => ({
  org: { findUnique: vi.fn(), update: vi.fn() },
}));

// The real Stripe client (offline), so signatures are checked for real.
const { stripe } = await vi.hoisted(async () => {
  const { default: Stripe } = await import("stripe");
  return { stripe: new Stripe("sk_test_webhook") };
});

vi.mock("server-only", () => ({}));
vi.mock("@repo/database", () => ({ database }));
vi.mock("@repo/payments", () => ({ stripe }));
vi.mock("@repo/analytics/server", () => ({ analytics: undefined }));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("next/headers", () => ({
  headers: async () => currentHeaders,
}));
vi.mock("@/env", () => ({ env: { STRIPE_WEBHOOK_SECRET: SECRET } }));

let currentHeaders = new Headers();

const { POST } = await import("../app/api/webhooks/payments/route");

const send = (event: object, secret = SECRET) => {
  const payload = JSON.stringify(event);
  currentHeaders = new Headers({
    "stripe-signature": stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
    }),
  });
  return POST(
    new Request("http://localhost/api/webhooks/payments", {
      method: "POST",
      body: payload,
    })
  );
};

const PERIOD_END = 1_798_761_600; // 2027-01-01

const subscription = (overrides: object = {}) => ({
  id: "sub_1",
  object: "subscription",
  customer: "cus_1",
  status: "active",
  cancel_at_period_end: false,
  metadata: { orgId: "org_1" },
  items: {
    data: [
      {
        current_period_end: PERIOD_END,
        price: { lookup_key: "takumo_pro_monthly" },
      },
    ],
  },
  ...overrides,
});

// Subscription events are re-read from Stripe; this is what Stripe returns.
const retrieves = (sub: object) =>
  vi
    .spyOn(stripe.subscriptions, "retrieve")
    .mockResolvedValue(
      sub as unknown as Awaited<
        ReturnType<typeof stripe.subscriptions.retrieve>
      >
    );

const event = (type: string, object: object) => ({
  id: "evt_1",
  object: "event",
  type,
  data: { object },
});

describe("Stripe webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.org.findUnique.mockResolvedValue({ id: "org_1" });
  });

  test("a bad signature is refused and nothing changes", async () => {
    const response = await send(
      event("customer.subscription.updated", subscription()),
      "whsec_wrong"
    );
    expect(response.status).toBe(400);
    expect(database.org.update).not.toHaveBeenCalled();
  });

  test("a new subscription puts the shop on its plan", async () => {
    retrieves(subscription());
    const response = await send(
      event("customer.subscription.created", subscription())
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      type: "customer.subscription.created",
    });
    expect(database.org.update).toHaveBeenCalledWith({
      where: { id: "org_1" },
      data: {
        stripeCustomerId: "cus_1",
        plan: "pro",
        stripeSubscriptionId: "sub_1",
        subscriptionStatus: "active",
        currentPeriodEnd: new Date(PERIOD_END * 1000),
        cancelAtPeriodEnd: false,
        pastDueSince: null,
      },
    });
  });

  test("checkout links the subscription to the shop that bought it", async () => {
    database.org.findUnique.mockImplementation(
      async ({ where }: { where: { id?: string } }) =>
        where.id === "org_9" ? { id: "org_9" } : null
    );
    const retrieve = vi
      .spyOn(stripe.subscriptions, "retrieve")
      .mockResolvedValue(
        subscription({ metadata: {} }) as unknown as Awaited<
          ReturnType<typeof stripe.subscriptions.retrieve>
        >
      );
    await send(
      event("checkout.session.completed", {
        id: "cs_1",
        object: "checkout.session",
        subscription: "sub_1",
        client_reference_id: "org_9",
      })
    );
    expect(retrieve).toHaveBeenCalledWith("sub_1");
    expect(database.org.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "org_9" },
        data: expect.objectContaining({ plan: "pro" }),
      })
    );
  });

  test("a failed payment marks the shop past due", async () => {
    vi.spyOn(stripe.subscriptions, "retrieve").mockResolvedValue(
      subscription({ status: "past_due" }) as unknown as Awaited<
        ReturnType<typeof stripe.subscriptions.retrieve>
      >
    );
    await send(
      event("invoice.payment_failed", {
        id: "in_1",
        object: "invoice",
        parent: { subscription_details: { subscription: "sub_1" } },
      })
    );
    expect(database.org.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subscriptionStatus: "past_due",
          pastDueSince: expect.any(Date),
        }),
      })
    );
  });

  test("an event for another subscription doesn't change the shop's", async () => {
    database.org.findUnique.mockResolvedValue({
      id: "org_1",
      stripeSubscriptionId: "sub_live",
    });
    retrieves(subscription({ id: "sub_stray", status: "canceled" }));
    const response = await send(
      event("customer.subscription.deleted", subscription({ id: "sub_stray" }))
    );
    expect(response.status).toBe(200);
    expect(database.org.update).not.toHaveBeenCalled();
  });

  test("a late event is applied as the subscription is now", async () => {
    retrieves(subscription({ status: "active" }));
    await send(
      event(
        "customer.subscription.created",
        subscription({ status: "incomplete" })
      )
    );
    expect(database.org.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subscriptionStatus: "active" }),
      })
    );
  });

  test("a cancelled subscription ends paid access but keeps the plan name", async () => {
    retrieves(subscription({ status: "canceled" }));
    await send(
      event(
        "customer.subscription.deleted",
        subscription({ status: "canceled" })
      )
    );
    expect(database.org.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subscriptionStatus: "canceled",
          stripeSubscriptionId: null,
          plan: "pro",
        }),
      })
    );
  });

  test("a subscription for a shop Takumo doesn't know is ignored", async () => {
    database.org.findUnique.mockResolvedValue(null);
    retrieves(subscription());
    const response = await send(
      event("customer.subscription.updated", subscription())
    );
    expect(response.status).toBe(200);
    expect(database.org.update).not.toHaveBeenCalled();
  });
});
