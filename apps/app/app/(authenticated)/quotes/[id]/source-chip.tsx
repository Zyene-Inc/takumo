"use client";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { cn } from "@repo/design-system/lib/utils";
import Link from "next/link";
import { describeSource, sourceHref } from "@/lib/quotes/review";
import type { CostSource } from "@/lib/quotes/types";

const KIND_HINT: Partial<Record<CostSource["kind"], string>> = {
  default:
    "Nothing in your shop's records backs this number yet. Check it, or set it in Settings → Quoting or on the record it belongs to.",
  estimator: "Typed in on this RFQ.",
  floor: "The owner set a lowest margin for this customer.",
  similar_part: "Taken from the closest part your shop already makes.",
  actuals: "Averaged from jobs that were run and clocked.",
  history: "From what this customer accepted on past quotes.",
};

/** A number's source as a chip; click it to see where it came from (F2.6-R2). */
export const SourceChip = ({ source }: { source: CostSource }) => {
  const href = sourceHref(source);
  const hint = KIND_HINT[source.kind];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "rounded border px-1.5 py-0.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            source.kind === "default"
              ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
              : "bg-muted/50 text-muted-foreground hover:bg-muted"
          )}
          type="button"
        >
          {source.label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-72 gap-2 text-sm">
        <p className="font-medium">Where this comes from</p>
        <p>{describeSource(source)}</p>
        {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
        {href && (
          <Link className="text-sm underline" href={href}>
            Open the record
          </Link>
        )}
      </PopoverContent>
    </Popover>
  );
};
