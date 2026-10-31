import { describe, expect, test } from "vitest";
import {
  billingFromSubscription,
  entitlements,
  lockedReason,
  type OrgBilling,
  planForLookupKey,
  trialEndsAt,
} from "../plans";

const NOW = new Date("2026-11-02T12:00:00Z");
const DAY = 86_400_000;

const org = (overrides: Partial<OrgBilling>): OrgBilling => ({
  plan: "trial",
  trialEndsAt: null,
  subscriptionStatus: null,
  currentPeriodEnd: null,
  pastDueSince: null,
  cancelAtPeriodEnd: false,
  ...overrides,
});

describe("entitlements", () => {
  test("a trial gets everything, counting down", () => {
    const e = entitlements(
      org({ trialEndsAt: new Date(NOW.getTime() + 12.5 * DAY) }),
      NOW
    );
    expect(e.state).toBe("trial");
    expect(e.trialDaysLeft).toBe(13);
    expect([...e.features].sort()).toEqual([
      "ask",
      "connectors",
      "knowledge",
      "quotes",
      "schedule",
    ]);
    expect(e.seats).toBeNull();
  });

  test("an ended trial loses paid features", () => {
    const e = entitlements(
      org({ trialEndsAt: new Date(NOW.getTime() - DAY) }),
      NOW
    );
    expect(e.state).toBe("expired");
    expect(e.features.size).toBe(0);
    expect(lockedReason(e, "ask")).toMatch(/free trial has ended/);
  });

  test("new shops get 30 days", () => {
    expect(trialEndsAt(NOW).getTime() - NOW.getTime()).toBe(30 * DAY);
  });

  test("Shop has the core features and 5 seats; Quote Copilot needs Pro", () => {
    const e = entitlements(
      org({ plan: "shop", subscriptionStatus: "active" }),
      NOW
    );
    expect(e.state).toBe("active");
    expect(e.seats).toBe(5);
    expect(e.features.has("ask")).toBe(true);
    expect(e.features.has("quotes")).toBe(false);
    expect(lockedReason(e, "quotes")).toBe(
      "Quote Copilot is on the Pro plan. Upgrade under Settings → Billing."
    );
    expect(lockedReason(e, "ask")).toBeNull();
  });

  test("Pro has everything, unlimited users", () => {
    const e = entitlements(
      org({ plan: "pro", subscriptionStatus: "active" }),
      NOW
    );
    expect(e.features.has("connectors")).toBe(true);
    expect(e.seats).toBeNull();
  });

  test("a failed payment keeps features for a week from when it failed", () => {
    // Stripe has already moved the period end a month ahead: it doesn't count.
    const nextMonth = new Date(NOW.getTime() + 27 * DAY);
    expect(
      entitlements(
        org({
          plan: "pro",
          subscriptionStatus: "past_due",
          currentPeriodEnd: nextMonth,
          pastDueSince: new Date(NOW.getTime() - 3 * DAY),
        }),
        NOW
      ).state
    ).toBe("past_due");
    const e = entitlements(
      org({
        plan: "pro",
        subscriptionStatus: "past_due",
        currentPeriodEnd: nextMonth,
        pastDueSince: new Date(NOW.getTime() - 8 * DAY),
      }),
      NOW
    );
    expect(e.state).toBe("canceled");
    expect(e.features.size).toBe(0);
  });

  test("a trial with no end date has ended", () => {
    expect(entitlements(org({}), NOW).state).toBe("expired");
  });

  test("a cancelled subscription has no paid features", () => {
    const e = entitlements(
      org({ plan: "pro", subscriptionStatus: "canceled" }),
      NOW
    );
    expect(e.state).toBe("canceled");
    expect(lockedReason(e, "quotes")).toMatch(/subscription has ended/);
  });

  test("Plant is set up by hand and always active", () => {
    expect(entitlements(org({ plan: "plant" }), NOW).state).toBe("active");
  });

  test("an unknown plan name is treated as a trial", () => {
    expect(
      entitlements(
        org({ plan: "gold", trialEndsAt: new Date(NOW.getTime() + DAY) }),
        NOW
      ).state
    ).toBe("trial");
  });
});

describe("Stripe subscriptions", () => {
  const sub = {
    id: "sub_1",
    status: "active",
    cancel_at_period_end: true,
    items: {
      data: [
        {
          current_period_end: 1_798_761_600,
          price: { lookup_key: "takumo_shop_monthly" },
        },
      ],
    },
  };

  test("map to the shop's billing fields", () => {
    expect(billingFromSubscription(sub)).toEqual({
      plan: "shop",
      stripeSubscriptionId: "sub_1",
      subscriptionStatus: "active",
      currentPeriodEnd: new Date(1_798_761_600_000),
      cancelAtPeriodEnd: true,
    });
  });

  test("an ended subscription drops its id; an unknown price keeps the plan", () => {
    expect(
      billingFromSubscription({ ...sub, status: "canceled" })
        .stripeSubscriptionId
    ).toBeNull();
    const other = {
      ...sub,
      items: { data: [{ price: { lookup_key: "something_else" } }] },
    };
    expect(billingFromSubscription(other)).not.toHaveProperty("plan");
    expect(planForLookupKey("takumo_pro_monthly")).toBe("pro");
    expect(planForLookupKey(null)).toBeNull();
  });
});
