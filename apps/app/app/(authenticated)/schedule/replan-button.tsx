"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { replanShop } from "./actions";
import { localToday } from "./gantt";

export const ReplanButton = ({
  label,
  size = "default",
}: {
  label: string;
  size?: "default" | "sm";
}) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex flex-col items-center gap-2">
      <Button
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const result = await replanShop(localToday());
            if (result.ok) {
              router.refresh();
            } else {
              setError([result.error, ...(result.conflicts ?? [])].join(" "));
            }
          })
        }
        size={size}
      >
        {pending ? <Spinner /> : <RefreshCwIcon />}
        {pending ? "Planning…" : label}
      </Button>
      {error && <span className="text-destructive text-sm">{error}</span>}
    </span>
  );
};
