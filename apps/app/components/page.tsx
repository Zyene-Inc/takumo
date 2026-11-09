// Page primitives: dense, edge-to-edge, hairline dividers.
//
// Adapted from Warmbly's dashboard (https://github.com/warmbly/warmbly,
// components/layout/Page.tsx, Apache-2.0), modified for Takumo: Next.js
// links instead of the TanStack router, and no compatibility shims.
//
// Pages fill the white content panel to its edges; sections separate by a
// single hairline, not by gutter or shadow. Small tracked-uppercase eyebrow
// labels replace large titles. Stats live in a strip across the full width.
//
//   <PageTopbar eyebrow="Quotes" subtitle="RFQs waiting for a price">
//     <TopbarAction href="/quotes/new">New quote</TopbarAction>
//   </PageTopbar>
//   <StatStrip cols={4}>
//     <Stat label="Open" value={12} accent />
//     ...
//   </StatStrip>
//   <SectionBar label="All RFQs" count={12}>{filters}</SectionBar>
//   <Row href="/quotes/1">...</Row>

import { cn } from "@repo/design-system/lib/utils";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

const isInternal = (href: string) =>
  href.startsWith("/") && !href.startsWith("//");

const Anchor = ({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) =>
  isInternal(href) ? (
    <Link className={className} href={href}>
      {children}
    </Link>
  ) : (
    <a className={className} href={href}>
      {children}
    </a>
  );

/** 48px bar at the top of a page: eyebrow, inline subtitle, actions. */
export const PageTopbar = ({
  eyebrow,
  eyebrowAs: Eyebrow = "h1",
  subtitle,
  children,
  className,
}: {
  eyebrow: string;
  /** The eyebrow is the page's heading unless the page has its own. */
  eyebrowAs?: "h1" | "span";
  subtitle?: ReactNode;
  children?: ReactNode;
  className?: string;
}) => (
  <div
    className={cn(
      "sticky top-0 z-10 flex min-h-12 shrink-0 flex-wrap items-center gap-3 gap-y-1.5 border-slate-200 border-b bg-white px-5 py-1.5 md:h-12 md:flex-nowrap md:py-0",
      className
    )}
  >
    <Eyebrow className="font-medium text-[10px] text-slate-400 uppercase tracking-[0.14em]">
      {eyebrow}
    </Eyebrow>
    {subtitle && (
      <>
        <div className="h-4 w-px bg-slate-200" />
        <span className="truncate text-[12.5px] text-slate-600">
          {subtitle}
        </span>
      </>
    )}
    {children && (
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5 md:flex-nowrap">
        {children}
      </div>
    )}
  </div>
);

/** A topbar action: a solid sky button, or a quiet outlined one. */
export const TopbarAction = ({
  children,
  href,
  icon,
  variant = "primary",
  className,
  ...button
}: {
  children: ReactNode;
  href?: string;
  icon?: ReactNode;
  variant?: "primary" | "ghost";
  className?: string;
} & Omit<ComponentProps<"button">, "children" | "className">) => {
  const cls = cn(
    "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-60",
    variant === "primary"
      ? "bg-sky-600 text-white hover:bg-sky-700"
      : "border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:text-slate-900",
    className
  );
  if (href) {
    return (
      <Anchor className={cls} href={href}>
        {icon}
        {children}
      </Anchor>
    );
  }
  return (
    <button className={cls} type="button" {...button}>
      {icon}
      {children}
    </button>
  );
};

const STRIP_COLS = {
  2: "grid-cols-2",
  3: "grid-cols-2 md:grid-cols-3 max-md:[&>*:last-child]:col-span-2",
  4: "grid-cols-2 md:grid-cols-4",
  5: "grid-cols-2 md:grid-cols-5 max-md:[&>*:last-child]:col-span-2",
  6: "grid-cols-2 md:grid-cols-3 xl:grid-cols-6 md:max-xl:[&>*:nth-child(3n)]:border-r-0",
} as const;

/** A full-width row of stats with hairline dividers. Use Stat inside. */
export const StatStrip = ({
  children,
  cols = 4,
}: {
  children: ReactNode;
  cols?: keyof typeof STRIP_COLS;
}) => (
  <div
    className={cn(
      "grid shrink-0 border-slate-200 border-b bg-white",
      "max-md:[&>*:last-child]:border-r-0 max-md:[&>*:nth-child(2n)]:border-r-0",
      STRIP_COLS[cols]
    )}
  >
    {children}
  </div>
);

const numberColour = (zero: boolean, tone?: "warn") => {
  if (zero) {
    return "text-slate-300";
  }
  return tone === "warn" ? "text-amber-700" : "text-slate-900";
};

/**
 * One cell of a StatStrip: label, number, quiet caption. `accent` marks
 * something live with a sky dot, `tone="warn"` colours a number that needs
 * attention, and a bare 0 fades.
 */
export const Stat = ({
  label,
  value,
  sub,
  accent = false,
  tone,
  active,
  href,
  last = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: boolean;
  tone?: "warn";
  active?: boolean;
  href?: string;
  last?: boolean;
}) => {
  const zero = value === 0 || value === "0";
  const inner = (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        {accent && (
          <span className="size-1.5 shrink-0 rounded-full bg-sky-500" />
        )}
        <span
          className={cn(
            "truncate font-medium text-[12px]",
            active ? "text-slate-900" : "text-slate-500"
          )}
        >
          {label}
        </span>
        {href && active === undefined && (
          <span className="ml-auto text-[11px] text-slate-300 transition-colors group-hover:text-slate-500">
            →
          </span>
        )}
      </div>
      <div
        className={cn(
          "mt-1.5 truncate font-semibold text-[20px] tabular-nums leading-none tracking-[-0.02em] md:text-[22px]",
          numberColour(zero, tone)
        )}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      {sub && (
        <div className="mt-1.5 truncate text-[11.5px] text-slate-400">
          {sub}
        </div>
      )}
      {active && (
        <span
          aria-hidden
          className="absolute inset-x-0 -bottom-px h-0.5 bg-sky-600"
        />
      )}
    </>
  );
  const cls = cn(
    "group relative min-w-0 px-5 py-2.5 transition-colors md:py-3.5",
    !last && "border-slate-200 border-r",
    href && "cursor-pointer hover:bg-slate-50",
    active && "bg-sky-50/40"
  );
  return href ? (
    <Anchor className={cls} href={href}>
      {inner}
    </Anchor>
  ) : (
    <div className={cls}>{inner}</div>
  );
};

/** The scrollable area below the topbar and strip. No padding. */
export const PageBody = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => (
  <div className={cn("min-h-0 flex-1 overflow-auto", className)}>
    {children}
  </div>
);

/** A slimmer sub-header inside a page: label, count, facts, toolbar. */
export const SectionBar = ({
  label,
  count,
  meta,
  children,
  className,
}: {
  label: string;
  count?: number | string;
  meta?: ReactNode;
  children?: ReactNode;
  className?: string;
}) => (
  <div
    className={cn(
      "flex min-h-9 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-slate-200/60 border-b px-5 py-1.5 md:h-9 md:flex-nowrap md:py-0",
      meta && "md:h-auto md:flex-wrap md:py-1.5",
      className
    )}
  >
    <span className="font-medium text-[10px] text-slate-400 uppercase tracking-[0.14em]">
      {label}
    </span>
    {count !== undefined && (
      <span className="font-mono text-[10.5px] text-slate-400 tabular-nums">
        {count}
      </span>
    )}
    {meta && (
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 md:ml-2">
        {meta}
      </div>
    )}
    {children && (
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
        {children}
      </div>
    )}
  </div>
);

/** A 44px list row with a hover state and a bottom hairline. */
export const Row = ({
  children,
  href,
  className,
}: {
  children: ReactNode;
  href?: string;
  className?: string;
}) => {
  const cls = cn(
    "group flex h-11 items-center gap-3 border-slate-200/60 border-b px-5 transition-colors",
    href && "cursor-pointer hover:bg-slate-50/80",
    className
  );
  return href ? (
    <Anchor className={cls} href={href}>
      {children}
    </Anchor>
  ) : (
    <div className={cls}>{children}</div>
  );
};

/** A tight, text-led empty state that fits inside a section. */
export const EmptyBlock = ({
  title,
  body,
  cta,
}: {
  title: string;
  body?: ReactNode;
  cta?: ReactNode;
}) => (
  <div className="px-5 py-16 text-center">
    <p className="mb-1 font-medium text-[12.5px] text-slate-700">{title}</p>
    {body && (
      <p className="mx-auto mb-4 max-w-[34ch] text-[11.5px] text-slate-400 leading-relaxed">
        {body}
      </p>
    )}
    {cta && <div className="mt-4 flex justify-center gap-1.5">{cta}</div>}
  </div>
);
