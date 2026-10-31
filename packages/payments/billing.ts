import "server-only";

import { database } from "@repo/database";
import { stripe } from "./index";
import {
  billingFromSubscription,
  PLANS,
  type PlanKey,
  SELF_SERVE,
  type SubscriptionLike,
} from "./plans";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const NOT_CONFIGURED =
  "Billing isn't set up yet (STRIPE_SECRET_KEY). Contact Takumo to subscribe.";

/** The shop's Stripe customer, created on first checkout. */
const customerFor = async (orgId: string, email: string | null) => {
  if (!stripe) {
    throw new Error(NOT_CONFIGURED);
  }
  const org = await database.org.findUniqueOrThrow({
    where: { id: orgId },
    select: { name: true, stripeCustomerId: true },
  });
  if (org.stripeCustomerId) {
    return org.stripeCustomerId;
  }
  const customer = await stripe.customers.create({
    name: org.name,
    ...(email ? { email } : {}),
    metadata: { orgId },
  });
  await database.org.update({
    where: { id: orgId },
    data: { stripeCustomerId: customer.id },
  });
  return customer.id;
};

/** Stripe Checkout for a self-serve plan; returns the page to send the buyer to. */
export const createCheckout = async ({
  orgId,
  plan,
  email,
  appUrl,
}: {
  appUrl: string;
  email: string | null;
  orgId: string;
  plan: PlanKey;
}): Promise<Result<{ url: string }>> => {
  if (!stripe) {
    return { ok: false, error: NOT_CONFIGURED };
  }
  const lookupKey = PLANS[plan].lookupKey;
  if (!(SELF_SERVE.includes(plan) && lookupKey)) {
    return {
      ok: false,
      error: "That plan is set up with you directly. Contact Takumo.",
    };
  }
  const current = await database.org.findUnique({
    where: { id: orgId },
    select: { stripeSubscriptionId: true, subscriptionStatus: true },
  });
  if (
    current?.stripeSubscriptionId &&
    current.subscriptionStatus !== "canceled"
  ) {
    return {
      ok: false,
      error:
        "This shop already has a subscription. Change plans under Manage billing.",
    };
  }
  const prices = await stripe.prices.list({
    lookup_keys: [lookupKey],
    active: true,
    limit: 1,
  });
  const price = prices.data[0];
  if (!price) {
    return {
      ok: false,
      error: `The ${PLANS[plan].name} price isn't in Stripe yet. Run scripts/setup-stripe.ts.`,
    };
  }
  const customer = await customerFor(orgId, email);
  // One checkout at a time: close pages opened earlier (another tab, a
  // colleague), so the shop can't end up paying for two subscriptions.
  const open = await stripe.checkout.sessions.list({
    customer,
    status: "open",
    limit: 10,
  });
  for (const earlier of open.data) {
    await stripe.checkout.sessions.expire(earlier.id);
  }
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: orgId,
    line_items: [{ price: price.id, quantity: 1 }],
    subscription_data: { metadata: { orgId } },
    allow_promotion_codes: true,
    billing_address_collection: "required",
    success_url: `${appUrl}/settings/billing?checkout=done`,
    cancel_url: `${appUrl}/settings/billing`,
  });
  return session.url
    ? { ok: true, url: session.url }
    : { ok: false, error: "Stripe didn't return a checkout page." };
};

/** Stripe's customer portal: change plan, card, invoices, cancel. */
export const createPortal = async ({
  orgId,
  appUrl,
}: {
  appUrl: string;
  orgId: string;
}): Promise<Result<{ url: string }>> => {
  if (!stripe) {
    return { ok: false, error: NOT_CONFIGURED };
  }
  const org = await database.org.findUnique({
    where: { id: orgId },
    select: { stripeCustomerId: true },
  });
  if (!org?.stripeCustomerId) {
    return { ok: false, error: "This shop has no subscription yet." };
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: org.stripeCustomerId,
    return_url: `${appUrl}/settings/billing`,
  });
  return { ok: true, url: session.url };
};

/**
 * Bring a shop's plan in line with a Stripe subscription (webhooks). The
 * shop is found by its Stripe customer, or by the orgId set at checkout.
 * Returns the shop's id, or null when the subscription isn't Takumo's.
 */
export const syncSubscription = async (
  sub: SubscriptionLike & {
    customer: string | { id: string };
    metadata?: Record<string, string> | null;
  }
) => {
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const select = {
    id: true,
    stripeSubscriptionId: true,
    subscriptionStatus: true,
    pastDueSince: true,
  } as const;
  const org =
    (await database.org.findUnique({
      where: { stripeCustomerId: customerId },
      select,
    })) ??
    (sub.metadata?.orgId
      ? await database.org.findUnique({
          where: { id: sub.metadata.orgId },
          select,
        })
      : null);
  if (!org) {
    return null;
  }
  // Another subscription is the shop's live one (a stray second checkout, an
  // old one's late event): this one mustn't change the shop's plan.
  if (org.stripeSubscriptionId && org.stripeSubscriptionId !== sub.id) {
    return { orgId: org.id, applied: false };
  }
  const billing = billingFromSubscription(sub);
  const pastDueSince =
    billing.subscriptionStatus === "past_due"
      ? ((org.subscriptionStatus === "past_due" ? org.pastDueSince : null) ??
        new Date())
      : null;
  await database.org.update({
    where: { id: org.id },
    data: { stripeCustomerId: customerId, ...billing, pastDueSince },
  });
  return { orgId: org.id, applied: true };
};
