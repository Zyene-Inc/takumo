"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { useState, useTransition } from "react";
import { openPortal, startCheckout } from "./actions";

const useRedirect = () => {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const go = (
    action: () => Promise<
      { ok: true; url: string } | { ok: false; error: string }
    >
  ) =>
    start(async () => {
      const r = await action();
      if (r.ok) {
        window.location.assign(r.url);
      } else {
        setError(r.error);
      }
    });
  return { error, pending, go };
};

export const ChoosePlan = ({
  plan,
  label,
  primary,
}: {
  label: string;
  plan: string;
  primary: boolean;
}) => {
  const { error, pending, go } = useRedirect();
  return (
    <div className="grid gap-1">
      <Button
        disabled={pending}
        onClick={() => go(() => startCheckout(plan))}
        variant={primary ? "default" : "outline"}
      >
        {pending && <Spinner />} {label}
      </Button>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
};

export const ManageBilling = () => {
  const { error, pending, go } = useRedirect();
  return (
    <div className="grid justify-items-start gap-1">
      <Button
        disabled={pending}
        onClick={() => go(openPortal)}
        variant="outline"
      >
        {pending && <Spinner />} Manage billing
      </Button>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
};
