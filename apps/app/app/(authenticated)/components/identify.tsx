"use client";

import { analytics } from "@repo/analytics";
import { useEffect } from "react";

/** Ties PostHog's browser events to the person and their shop. */
export const Identify = ({
  user,
  shop,
}: {
  shop: { id: string; name: string; plan: string };
  user: { email: string; id: string; name: string };
}) => {
  useEffect(() => {
    // No-ops when PostHog isn't initialised (no NEXT_PUBLIC_POSTHOG_KEY).
    if (!analytics.__loaded) {
      return;
    }
    analytics.identify(user.id, { email: user.email, name: user.name });
    analytics.group("company", shop.id, { name: shop.name, plan: shop.plan });
  }, [user.id, user.email, user.name, shop.id, shop.name, shop.plan]);
  return null;
};
