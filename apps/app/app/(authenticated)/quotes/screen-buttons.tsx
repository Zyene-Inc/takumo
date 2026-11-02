"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { useState, useTransition } from "react";
import { screenRfq } from "./actions";

/**
 * The person's call on an RFQ screening held back: quote it (Takumo reads,
 * prices and drafts it, and trusts the sender next time), not an RFQ, or
 * block the sender.
 */
export const ScreenButtons = ({
  rfqId,
  filtered,
}: {
  filtered: boolean;
  rfqId: string;
}) => {
  const [pending, start] = useTransition();
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (answer: "quote" | "not_rfq" | "block") => {
    setWorking(answer);
    setError(null);
    start(async () => {
      const result = await screenRfq(rfqId, answer);
      if (!result.ok) {
        setError(result.error);
      }
      setWorking(null);
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={pending} onClick={() => run("quote")} size="sm">
        {working === "quote" && <Spinner />} Quote it
      </Button>
      {!filtered && (
        <Button
          disabled={pending}
          onClick={() => run("not_rfq")}
          size="sm"
          variant="outline"
        >
          {working === "not_rfq" && <Spinner />} Not an RFQ
        </Button>
      )}
      <Button
        disabled={pending}
        onClick={() => run("block")}
        size="sm"
        variant="ghost"
      >
        {working === "block" && <Spinner />} Block sender
      </Button>
      {error && <span className="text-destructive text-sm">{error}</span>}
    </div>
  );
};
