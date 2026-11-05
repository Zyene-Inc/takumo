"use client";

// Small pieces shared by the RFQ line card: formatting, source chips, notices.

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import type { OperationSource } from "@repo/engine-client/types";
import {
  AlertTriangleIcon,
  ChevronRightIcon,
  InfoIcon,
  XCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode } from "react";
import type { LineView } from "@/lib/quotes/view";

export const usd = (value: number | null | undefined, cents = true) =>
  value === null || value === undefined
    ? "—"
    : value.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: cents ? 2 : 0,
        maximumFractionDigits: cents ? 2 : 0,
      });

export const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;

export const SOURCE_LABEL: Record<OperationSource, string> = {
  routing: "Shop routing",
  actuals: "Actual times",
  comparable: "Estimated",
  estimator: "Entered",
};

export const quoteHref = (quoteNo: string) =>
  `/quotes/history?q=${encodeURIComponent(quoteNo)}`;

export const OUTCOME_VARIANT: Record<
  string,
  "default" | "outline" | "secondary"
> = {
  won: "default",
  lost: "outline",
  open: "secondary",
};

export const sourceHref = (kind: string, name: string) => {
  const q = (value: string) => encodeURIComponent(value);
  switch (kind) {
    case "quote":
      return quoteHref(name);
    case "machine":
      return `/shop/work-centers?q=${q(name)}`;
    case "routing":
      return `/shop/parts?q=${q(name.split(" op ")[0])}`;
    case "material":
      return `/shop/materials?q=${q(name)}`;
    default:
      return null;
  }
};

/** "quote Q-9001" → a link; other sources as plain chips. */
export const SourceChip = ({ id }: { id: string }) => {
  const [kind, ...rest] = id.split(" ");
  const name = rest.join(" ");
  const href = sourceHref(kind, name);
  const chip = (
    <span className="rounded border bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {id}
    </span>
  );
  return href ? (
    <Link className="hover:underline" href={href}>
      {chip}
    </Link>
  ) : (
    chip
  );
};

// ---------------------------------------------------------------------------
// Line spec (what the customer asked for)

export const MatchBadge = ({ line }: { line: LineView }) => {
  if (line.part) {
    return (
      <Link href={`/shop/parts/${line.part.id}`}>
        <Badge variant="secondary">In your shop</Badge>
      </Link>
    );
  }
  if (line.otherRev) {
    return (
      <Badge variant="outline">New revision · shop has {line.otherRev}</Badge>
    );
  }
  return <Badge variant="outline">New part</Badge>;
};

// ---------------------------------------------------------------------------
// Prices: the draft and what the estimator will send

export const Notices = ({ line }: { line: LineView }) => {
  const r = line.draft?.response;
  if (!r) {
    return null;
  }
  return (
    <div className="grid gap-2">
      {r.missing.length > 0 && (
        <Alert variant="destructive">
          <XCircleIcon />
          <AlertDescription>
            Can't price this yet: {r.missing.join("; ")}. Fill it in under
            Operations and inputs.
          </AlertDescription>
        </Alert>
      )}
      {[...r.warnings, ...(line.draft?.routingNotes ?? [])].map((w) => (
        <div
          className="flex gap-2 text-amber-700 text-sm dark:text-amber-400"
          key={w}
        >
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" /> {w}
        </div>
      ))}
      {r.checks.map((c) => (
        <div className="flex gap-2 text-muted-foreground text-sm" key={c}>
          <InfoIcon className="mt-0.5 size-4 shrink-0" /> {c}
        </div>
      ))}
    </div>
  );
};

export const Fold = ({
  title,
  children,
  open = false,
}: {
  children: ReactNode;
  open?: boolean;
  title: string;
}) => (
  <Collapsible defaultOpen={open}>
    <CollapsibleTrigger className="group flex items-center gap-1 font-medium text-sm">
      <ChevronRightIcon className="size-4 transition-transform group-data-[state=open]:rotate-90" />
      {title}
    </CollapsibleTrigger>
    <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
  </Collapsible>
);

export const minutes = (value: number) =>
  `${Math.round(value * 100) / 100} min`;
