import "server-only";

import { database } from "@repo/database";
import { entitlements, type Feature, lockedReason } from "@repo/payments/plans";
import { budgetProblem } from "./ai-usage";

/** The shop's plan and what it may use now. */
export const getBilling = async (orgId: string) => {
  const org = await database.org.findUnique({
    where: { id: orgId },
    select: {
      plan: true,
      trialEndsAt: true,
      subscriptionStatus: true,
      currentPeriodEnd: true,
      pastDueSince: true,
      cancelAtPeriodEnd: true,
      stripeCustomerId: true,
    },
  });
  const billing = org ?? {
    plan: "trial",
    trialEndsAt: null,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    pastDueSince: null,
    cancelAtPeriodEnd: false,
    stripeCustomerId: null,
  };
  return { ...billing, entitlements: entitlements(billing) };
};

/** Features that call Claude, and so count against the monthly AI cap. */
const AI_FEATURES: readonly Feature[] = ["ask", "quotes", "knowledge"];

/**
 * For server actions: null when the shop may use the feature, else why not
 * (not on its plan, or its monthly AI allowance is spent).
 */
export const featureProblem = async (orgId: string, feature: Feature) =>
  lockedReason((await getBilling(orgId)).entitlements, feature) ??
  (AI_FEATURES.includes(feature) ? await budgetProblem(orgId) : null);
