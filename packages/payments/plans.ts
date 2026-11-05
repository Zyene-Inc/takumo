// Takumo's plans and what each shop may use. Pure (no Stripe calls, no
// database), shared by the app, the Stripe webhook and the tests.
// Prices: docs/MARKET.md.

export const PLAN_KEYS = ["trial", "shop", "pro", "plant"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export const FEATURES = [
  "ask",
  "schedule",
  "knowledge",
  "quotes",
  "connectors",
] as const;
export type Feature = (typeof FEATURES)[number];

interface Plan {
  features: readonly Feature[];
  key: PlanKey;
  /** Stripe price lookup key (scripts/setup-stripe.ts creates the prices). */
  lookupKey: string | null;
  name: string;
  /** USD per month; null = custom. */
  price: number | null;
  /** Users included; null = unlimited. */
  seats: number | null;
  summary: string;
}

const CORE: Feature[] = ["ask", "schedule", "knowledge"];
const ALL: Feature[] = [...FEATURES];

export const PLANS: Record<PlanKey, Plan> = {
  trial: {
    key: "trial",
    name: "Free trial",
    price: 0,
    seats: null,
    features: ALL,
    lookupKey: null,
    summary: "Everything in Pro while you try Takumo.",
  },
  shop: {
    key: "shop",
    name: "Shop",
    price: 499,
    seats: 5,
    features: CORE,
    lookupKey: "takumo_shop_monthly",
    summary:
      "One site, 5 users: Ask Takumo, capacity checks, the schedule and tribal knowledge.",
  },
  pro: {
    key: "pro",
    name: "Pro",
    price: 1499,
    seats: null,
    features: ALL,
    lookupKey: "takumo_pro_monthly",
    summary:
      "Everything in Shop, plus Quote Copilot, QuickBooks and Gmail connectors, unlimited users.",
  },
  plant: {
    key: "plant",
    name: "Plant",
    price: null,
    seats: null,
    features: ALL,
    lookupKey: null,
    summary: "Several sites, SSO and onboarding help. Priced with you.",
  },
};

/** Plans a shop can buy online. */
export const SELF_SERVE: readonly PlanKey[] = ["shop", "pro"];

export const TRIAL_DAYS = 30;
/** Days a shop keeps paid features after a payment fails. */
const PAST_DUE_GRACE_DAYS = 7;

const DAY_MS = 86_400_000;

/** When a new shop's free trial ends. */
export const trialEndsAt = (from = new Date()) =>
  new Date(from.getTime() + TRIAL_DAYS * DAY_MS);

export const FEATURE_LABEL: Record<Feature, string> = {
  ask: "Ask Takumo",
  schedule: "Scheduling and capacity checks",
  knowledge: "Tribal knowledge",
  quotes: "Quote Copilot",
  connectors: "QuickBooks and Gmail connectors",
};

export interface OrgBilling {
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  /** When the subscription went past due. */
  pastDueSince: Date | null;
  plan: string;
  subscriptionStatus: string | null;
  trialEndsAt: Date | null;
}

type AccessState =
  | "trial" // free trial, all features
  | "active" // paid (or a custom Plant plan)
  | "past_due" // payment failed: features kept for a grace period
  | "expired" // trial over, no subscription
  | "canceled"; // subscription ended

interface Entitlements {
  /** Paid features this shop can use now. */
  features: ReadonlySet<Feature>;
  plan: Plan;
  /** Users included (null = unlimited). */
  seats: number | null;
  state: AccessState;
  /** Whole days left in the trial (trial only). */
  trialDaysLeft: number | null;
}

const PAID: readonly string[] = ["active", "trialing"];

const planOf = (key: string): Plan =>
  PLANS[
    (PLAN_KEYS as readonly string[]).includes(key) ? (key as PlanKey) : "trial"
  ];

/** What a shop may use right now, from its billing state. */
export const entitlements = (
  org: OrgBilling,
  now = new Date()
): Entitlements => {
  const plan = planOf(org.plan);
  const none = new Set<Feature>();
  if (plan.key === "trial") {
    // Every shop gets its trial end when it's created; none means no trial.
    const left = org.trialEndsAt
      ? Math.ceil((org.trialEndsAt.getTime() - now.getTime()) / DAY_MS)
      : 0;
    return left > 0
      ? {
          plan,
          state: "trial",
          features: new Set(plan.features),
          seats: null,
          trialDaysLeft: left,
        }
      : {
          plan,
          state: "expired",
          features: none,
          seats: null,
          trialDaysLeft: 0,
        };
  }
  if (plan.key === "plant") {
    return {
      plan,
      state: "active",
      features: new Set(plan.features),
      seats: null,
      trialDaysLeft: null,
    };
  }
  const status = org.subscriptionStatus ?? "";
  if (PAID.includes(status)) {
    return {
      plan,
      state: "active",
      features: new Set(plan.features),
      seats: plan.seats,
      trialDaysLeft: null,
    };
  }
  if (status === "past_due") {
    // From the failed payment, not the period end: Stripe has already moved
    // that to the end of the unpaid period.
    const graceEnds = org.pastDueSince
      ? org.pastDueSince.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS
      : 0;
    return now.getTime() < graceEnds
      ? {
          plan,
          state: "past_due",
          features: new Set(plan.features),
          seats: plan.seats,
          trialDaysLeft: null,
        }
      : {
          plan,
          state: "canceled",
          features: none,
          seats: plan.seats,
          trialDaysLeft: null,
        };
  }
  return {
    plan,
    state: "canceled",
    features: none,
    seats: plan.seats,
    trialDaysLeft: null,
  };
};

/** Why a feature isn't available, for the person who hit the wall. */
export const lockedReason = (e: Entitlements, feature: Feature) => {
  if (e.features.has(feature)) {
    return null;
  }
  if (e.state === "expired") {
    return `Your free trial has ended. Choose a plan to keep using ${FEATURE_LABEL[feature]}.`;
  }
  if (e.state === "canceled") {
    return `Your subscription has ended. Choose a plan to keep using ${FEATURE_LABEL[feature]}.`;
  }
  return `${FEATURE_LABEL[feature]} is on the Pro plan. Upgrade under Settings → Billing.`;
};

export const planForLookupKey = (
  lookupKey: string | null | undefined
): PlanKey | null =>
  Object.values(PLANS).find((p) => p.lookupKey && p.lookupKey === lookupKey)
    ?.key ?? null;

/** The subset of a Stripe subscription the shop's billing state comes from. */
export interface SubscriptionLike {
  cancel_at_period_end: boolean;
  id: string;
  items: {
    data: {
      current_period_end?: number | null;
      price: { lookup_key: string | null };
    }[];
  };
  status: string;
}

/** The Org fields a Stripe subscription sets. */
export const billingFromSubscription = (sub: SubscriptionLike) => {
  const item = sub.items.data[0];
  const plan = planForLookupKey(item?.price.lookup_key);
  const ended =
    sub.status === "canceled" || sub.status === "incomplete_expired";
  return {
    // A price Takumo doesn't know keeps the shop on its current plan.
    ...(plan ? { plan } : {}),
    stripeSubscriptionId: ended ? null : sub.id,
    subscriptionStatus: sub.status,
    currentPeriodEnd: item?.current_period_end
      ? new Date(item.current_period_end * 1000)
      : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  };
};
