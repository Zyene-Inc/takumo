"use server";

import { withAuth } from "@repo/auth/server";
import { log } from "@repo/observability/log";
import { createCheckout, createPortal } from "@repo/payments/billing";
import { PLAN_KEYS, type PlanKey } from "@repo/payments/plans";
import { env } from "@/env";
import { authorize } from "@/lib/access";
import { track } from "@/lib/analytics";

type Result = { ok: true; url: string } | { ok: false; error: string };

const failed = (error: unknown): Result => {
  log.error("Stripe request failed", { error: String(error) });
  return { ok: false, error: "Stripe didn't respond. Try again in a minute." };
};

/** Stripe Checkout for a plan; the browser goes to the URL. */
export const startCheckout = async (plan: string): Promise<Result> => {
  const access = await authorize("billing:manage");
  if (!access.ok) {
    return access;
  }
  if (!(PLAN_KEYS as readonly string[]).includes(plan)) {
    return { ok: false, error: "Unknown plan." };
  }
  const { user } = await withAuth({ ensureSignedIn: true });
  track("checkout_started", {
    orgId: access.orgId,
    userId: user.id,
    properties: { plan },
  });
  try {
    return await createCheckout({
      orgId: access.orgId,
      plan: plan as PlanKey,
      email: user.email,
      appUrl: env.NEXT_PUBLIC_APP_URL,
    });
  } catch (error) {
    return failed(error);
  }
};

/** Stripe's billing portal: card, invoices, plan changes, cancelling. */
export const openPortal = async (): Promise<Result> => {
  const access = await authorize("billing:manage");
  if (!access.ok) {
    return access;
  }
  try {
    return await createPortal({
      orgId: access.orgId,
      appUrl: env.NEXT_PUBLIC_APP_URL,
    });
  } catch (error) {
    return failed(error);
  }
};
