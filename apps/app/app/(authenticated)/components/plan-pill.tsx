// The plan badge in the header. Styled after Warmbly's PlanPill
// (https://github.com/warmbly/warmbly, Apache-2.0), modified for Takumo's
// plans: trial, Shop, Pro and Plant, plus the billing states that need a look.

import { cn } from "@repo/design-system/lib/utils";
import Link from "next/link";

export type PlanTone = "sky" | "slate" | "ink" | "red";

export interface PlanBadge {
  label: string;
  tone: PlanTone;
}

const TONES: Record<PlanTone, { pill: string; dot: string }> = {
  sky: { pill: "bg-sky-50 text-sky-700 border-sky-100", dot: "bg-sky-500" },
  slate: {
    pill: "bg-slate-100 text-slate-600 border-slate-200",
    dot: "bg-slate-400",
  },
  ink: {
    pill: "bg-slate-900 text-white border-slate-900",
    dot: "bg-white",
  },
  red: { pill: "bg-red-50 text-red-700 border-red-100", dot: "bg-red-500" },
};

export const PlanPill = ({ badge }: { badge: PlanBadge }) => (
  <Link
    className={cn(
      "inline-flex h-6 items-center gap-1.5 rounded border px-2 font-semibold text-[11px] uppercase tracking-[0.08em] transition-colors hover:brightness-105",
      TONES[badge.tone].pill
    )}
    href="/settings/billing"
    title="Plans and billing"
  >
    <span className={cn("size-1.5 rounded-full", TONES[badge.tone].dot)} />
    {badge.label}
  </Link>
);
