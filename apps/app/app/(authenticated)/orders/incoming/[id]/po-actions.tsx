"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { markPoEntered, rejectPo, rereadPo } from "../actions";

/** Copy the plain-text order, to paste into the ERP or an email. */
export const CopySummary = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      size="sm"
      type="button"
      variant="outline"
    >
      {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : "Copy"}
    </Button>
  );
};

export const CsvLink = ({ poId }: { poId: string }) => (
  <Button asChild size="sm" variant="outline">
    <a href={`/orders/incoming/${poId}/csv`}>
      <DownloadIcon /> CSV
    </a>
  </Button>
);

/** Entered in the ERP / reject / read again. */
export const PoButtons = ({
  poId,
  status,
}: {
  poId: string;
  status: string;
}) => {
  const [pending, start] = useTransition();
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (
    key: string,
    action: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>
  ) => {
    setWorking(key);
    setError(null);
    start(async () => {
      const result = await action(poId);
      if (!result.ok) {
        setError(result.error);
      }
      setWorking(null);
    });
  };
  if (!(status === "review" || status === "failed")) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "review" && (
        <Button
          disabled={pending}
          onClick={() => run("entered", markPoEntered)}
          size="sm"
        >
          {working === "entered" && <Spinner />} Mark entered in ERP
        </Button>
      )}
      <Button
        disabled={pending}
        onClick={() => run("reread", rereadPo)}
        size="sm"
        variant="outline"
      >
        {working === "reread" && <Spinner />} Read again
      </Button>
      <Button
        disabled={pending}
        onClick={() => run("reject", rejectPo)}
        size="sm"
        variant="ghost"
      >
        {working === "reject" && <Spinner />} Reject
      </Button>
      {error && <span className="text-destructive text-sm">{error}</span>}
    </div>
  );
};
