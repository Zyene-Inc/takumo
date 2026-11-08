"use client";

import {
  CalculatorIcon,
  CalendarRangeIcon,
  DatabaseIcon,
  FileTextIcon,
  FlaskConicalIcon,
  GaugeIcon,
  LightbulbIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import type { Source, SourceKind } from "@/lib/agent/citations";

const KIND_ICON: Partial<Record<SourceKind, LucideIcon>> = {
  doc: FileTextIcon,
  query: DatabaseIcon,
  plan: CalendarRangeIcon,
  check: GaugeIcon,
  scenario: FlaskConicalIcon,
  estimate: CalculatorIcon,
  fact: LightbulbIcon,
};

const sourceTitle = (source: Source) =>
  [source.label, source.kind === "query" ? source.detail : undefined]
    .filter(Boolean)
    .join(": ");

/** A numbered citation, like a footnote, linking to the record. */
export const CitationMark = ({ n, source }: { n: number; source: Source }) => {
  const className =
    "mx-0.5 inline-flex h-[1.4em] min-w-[1.4em] items-center justify-center rounded-full bg-muted px-1 align-[0.15em] font-medium text-[0.7em] text-muted-foreground no-underline transition-colors hover:bg-primary hover:text-primary-foreground";
  return source.href ? (
    <Link
      aria-label={`Source ${n}: ${source.label}`}
      className={className}
      href={source.href}
      title={sourceTitle(source)}
    >
      {n}
    </Link>
  ) : (
    <span className={className} title={sourceTitle(source)}>
      {n}
      <span className="sr-only">: {source.label}</span>
    </span>
  );
};

/** A source's name, with its kind's icon, linking to the record. */
export const SourceName = ({ source }: { source: Source }) => {
  const Icon = KIND_ICON[source.kind];
  const body = (
    <>
      {Icon && <Icon className="size-3 shrink-0" />}
      {source.label}
    </>
  );
  const className =
    "inline-flex items-center gap-1 font-medium text-foreground";
  return source.href ? (
    <Link className={`${className} hover:underline`} href={source.href}>
      {body}
    </Link>
  ) : (
    <span className={className}>{body}</span>
  );
};
