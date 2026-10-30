import "server-only";

import { database } from "@repo/database";
import { entitlements, type Feature, lockedReason } from "@repo/payments/plans";

/** The shop's plan and what it may use now. */
export const getBilling = async (orgId: string) => {
  const org = await database.org.findUnique({
    where: { id: orgId },
    select: {
      plan: true,
      trialEndsAt: true,
      subscriptionStatus: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
      stripeCustomerId: true,
    },
  });
  const billing = org ?? {
    plan: "trial",
    trialEndsAt: null,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    stripeCustomerId: null,
  };
  return { ...billing, entitlements: entitlements(billing) };
};

export type Billing = Awaited<ReturnType<typeof getBilling>>;

/** For server actions: null when the shop may use the feature, else why not. */
export const featureProblem = async (orgId: string, feature: Feature) =>
  lockedReason((await getBilling(orgId)).entitlements, feature);
