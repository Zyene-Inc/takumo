import { analytics } from "@repo/analytics/server";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import type { Stripe } from "@repo/payments";
import { stripe } from "@repo/payments";
import { syncSubscription } from "@repo/payments/billing";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "@/env";

// Billing is per shop: the Stripe customer and subscription live on the Org
// row, and every subscription change here updates the shop's plan.

const track = (
  orgId: string,
  event: string,
  properties: Record<string, unknown>
) =>
  analytics?.capture({
    event,
    distinctId: orgId,
    groups: { company: orgId },
    properties,
  });

const subscriptionChanged = async (sub: Stripe.Subscription, event: string) => {
  const orgId = await syncSubscription(sub);
  if (!orgId) {
    log.warn("Stripe subscription for an unknown shop", {
      subscription: sub.id,
    });
    return;
  }
  track(orgId, event, {
    status: sub.status,
    plan: sub.items.data[0]?.price.lookup_key ?? null,
    cancel_at_period_end: sub.cancel_at_period_end,
  });
};

const checkoutCompleted = async (session: Stripe.Checkout.Session) => {
  if (!(stripe && session.subscription)) {
    return;
  }
  const id =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription.id;
  const sub = await stripe.subscriptions.retrieve(id);
  // The checkout knows the shop even if the customer was made elsewhere.
  await subscriptionChanged(
    {
      ...sub,
      metadata: {
        ...sub.metadata,
        orgId: sub.metadata?.orgId ?? session.client_reference_id ?? "",
      },
    },
    "subscription_started"
  );
};

const paymentFailed = async (invoice: Stripe.Invoice) => {
  const subscription = invoice.parent?.subscription_details?.subscription;
  if (!(stripe && subscription)) {
    return;
  }
  const id = typeof subscription === "string" ? subscription : subscription.id;
  await subscriptionChanged(
    await stripe.subscriptions.retrieve(id),
    "payment_failed"
  );
};

export const POST = async (request: Request): Promise<Response> => {
  if (!(stripe && env.STRIPE_WEBHOOK_SECRET)) {
    return NextResponse.json({ message: "Not configured", ok: false });
  }

  let event: Stripe.Event;
  try {
    const body = await request.text();
    const signature = (await headers()).get("stripe-signature");
    if (!signature) {
      throw new Error("missing stripe-signature header");
    }
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    log.warn("Rejected a Stripe webhook", { error: parseError(error) });
    return NextResponse.json(
      { message: "Invalid signature", ok: false },
      { status: 400 }
    );
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await checkoutCompleted(event.data.object);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await subscriptionChanged(event.data.object, "subscription_updated");
        break;
      case "customer.subscription.deleted":
        await subscriptionChanged(event.data.object, "subscription_canceled");
        break;
      case "invoice.payment_failed":
        await paymentFailed(event.data.object);
        break;
      default:
        log.info(`Ignored Stripe event ${event.type}`);
    }
    await analytics?.shutdown();
    return NextResponse.json({ ok: true, type: event.type });
  } catch (error) {
    log.error("Stripe webhook failed", {
      type: event.type,
      error: parseError(error),
    });
    // 500 so Stripe retries.
    return NextResponse.json(
      { message: "something went wrong", ok: false },
      { status: 500 }
    );
  }
};
