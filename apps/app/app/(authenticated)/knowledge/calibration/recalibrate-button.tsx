"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { recalibrateNow } from "./actions";

export const RecalibrateButton = ({ canRun }: { canRun: boolean }) => {
  const router = useRouter();
  const [message, setMessage] = useState<{
    text: string;
    facts: string[];
  } | null>(null);
  const [pending, start] = useTransition();
  if (!canRun) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await recalibrateNow();
            if (!r.ok) {
              setMessage({ text: r.error, facts: [] });
              return;
            }
            const facts = [...r.proposed, ...r.refreshed];
            setMessage({
              text: facts.length
                ? `Checked ${r.operations} operations. For review:`
                : `Checked ${r.operations} operations: nothing new to change.`,
              facts,
            });
            router.refresh();
          })
        }
        size="sm"
        variant="outline"
      >
        {pending ? <Spinner /> : <RefreshCwIcon />} Recalibrate now
      </Button>
      {message && (
        <span className="text-sm">
          {message.text}{" "}
          {message.facts.map((f) => (
            <Link
              className="mr-1 font-medium underline"
              href={`/knowledge/facts?f=${f}`}
              key={f}
            >
              {f}
            </Link>
          ))}
        </span>
      )}
    </div>
  );
};
