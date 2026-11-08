"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { ShieldIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { turnOnRestricted } from "./actions";

/** The owner turns on restricted access, once, after reading what it does. */
export const TurnOnRestricted = () => {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="grid gap-2 rounded-lg border p-3">
      {confirming ? (
        <>
          <p className="text-sm">
            This adds HR, Finance, Receipts and Contracts folders that only
            their departments (and you) can open, with AI processing off. It
            can't be turned off again: restricted documents would otherwise be
            shown to everyone.
          </p>
          <div className="flex gap-2">
            <Button
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await turnOnRestricted();
                  if (r.ok) {
                    router.refresh();
                  } else {
                    setError(r.error);
                  }
                })
              }
              size="sm"
            >
              {pending ? <Spinner /> : <ShieldIcon />} Turn on restricted access
            </Button>
            <Button
              onClick={() => setConfirming(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <Button
          className="justify-self-start"
          onClick={() => setConfirming(true)}
          size="sm"
          variant="outline"
        >
          <ShieldIcon /> Turn on restricted access…
        </Button>
      )}
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};
