"use client";

import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/design-system/components/ui/chart";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { cn } from "@repo/design-system/lib/utils";
import {
  AlertTriangleIcon,
  BookOpenIcon,
  CalculatorIcon,
  CalendarRangeIcon,
  ChevronRightIcon,
  DatabaseIcon,
  FileTextIcon,
  FlaskConicalIcon,
  GaugeIcon,
  type LucideIcon,
  SearchIcon,
  TableIcon,
} from "lucide-react";
import Link from "next/link";
import { type AnchorHTMLAttributes, memo, useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import { Streamdown } from "streamdown";
import {
  linkCitations,
  type Source,
  type SourceKind,
} from "@/lib/agent/citations";
import type { Artifact } from "@/lib/agent/tools";
import { snippetRuns } from "@/lib/knowledge/chunk";

const SAFE_LINK = /^(https?:\/\/|\/(?!\/))/i;

const KIND_ICON: Partial<Record<SourceKind, LucideIcon>> = {
  doc: FileTextIcon,
  query: DatabaseIcon,
  plan: CalendarRangeIcon,
  check: GaugeIcon,
  scenario: FlaskConicalIcon,
  estimate: CalculatorIcon,
};

const sourceTitle = (source: Source) =>
  [source.label, source.kind === "query" ? source.detail : undefined]
    .filter(Boolean)
    .join(": ");

/** A numbered citation, like a footnote, linking to the record. */
const CitationMark = ({ n, source }: { n: number; source: Source }) => {
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
const SourceName = ({ source }: { source: Source }) => {
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

/** Footnote numbers for an answer: sources in order of first citation. */
export const citationNumbers = (
  texts: string[],
  registry: ReadonlyMap<string, Source>
) => {
  const numbers = new Map<string, number>();
  for (const text of texts) {
    for (const source of linkCitations(text, registry).cited) {
      if (!numbers.has(source.id)) {
        numbers.set(source.id, numbers.size + 1);
      }
    }
  }
  return numbers;
};

/** Markdown answer with [kind id] citations turned into chips. */
export const AnswerText = ({
  text,
  registry,
  numbers,
  streaming,
}: {
  numbers: ReadonlyMap<string, number>;
  registry: ReadonlyMap<string, Source>;
  streaming: boolean;
  text: string;
}) => {
  const { markdown, cited } = useMemo(
    () => linkCitations(text, registry),
    [text, registry]
  );
  const components = useMemo(
    () => ({
      a: ({
        href,
        children,
        ...props
      }: AnchorHTMLAttributes<HTMLAnchorElement>) => {
        const index = href?.startsWith("#cite-") ? Number(href.slice(6)) : -1;
        const source = cited[index];
        if (source) {
          return (
            <CitationMark
              n={numbers.get(source.id) ?? index + 1}
              source={source}
            />
          );
        }
        // Only web links and links within the app; anything else is plain text.
        if (!(href && SAFE_LINK.test(href))) {
          return <span>{children}</span>;
        }
        const external = !href.startsWith("/");
        return (
          <a
            {...props}
            className="underline"
            href={href}
            rel={external ? "noreferrer noopener" : undefined}
            target={external ? "_blank" : undefined}
          >
            {children}
          </a>
        );
      },
    }),
    [cited, numbers]
  );
  return (
    <Streamdown
      className="text-sm leading-relaxed [&_li]:my-0.5 [&_p]:my-2 [&_ul]:my-2"
      components={components}
      controls={{ code: true, table: true, mermaid: false }}
      isAnimating={streaming}
    >
      {markdown}
    </Streamdown>
  );
};

const TOOL_LABEL: Record<
  string,
  { icon: LucideIcon; running: string; done: string }
> = {
  query_data: {
    icon: DatabaseIcon,
    running: "Querying your data",
    done: "Queried your data",
  },
  search_documents: {
    icon: SearchIcon,
    running: "Searching documents",
    done: "Searched documents",
  },
  get_record: {
    icon: BookOpenIcon,
    running: "Looking it up",
    done: "Looked up",
  },
  get_schedule: {
    icon: CalendarRangeIcon,
    running: "Reading the plan",
    done: "Read the plan",
  },
  check_capacity: {
    icon: GaugeIcon,
    running: "Running the scheduler",
    done: "Checked capacity",
  },
  run_scenario: {
    icon: FlaskConicalIcon,
    running: "Re-planning the scenario",
    done: "Ran a scenario",
  },
  estimate_quote: {
    icon: CalculatorIcon,
    running: "Pricing it",
    done: "Priced it",
  },
  show_artifact: {
    icon: TableIcon,
    running: "Building a view",
    done: "Built a view",
  },
};

export interface ToolPartView {
  errorText?: string;
  input?: unknown;
  output?: unknown;
  state: string;
  tool: string;
}

const CAPACITY_ANSWER: Record<string, string | undefined> = {
  true: "yes",
  false: "not as is",
};

const rowsLabel = (output: Record<string, unknown>) => {
  if (typeof output.row_count !== "number") {
    return undefined;
  }
  const plural = output.row_count === 1 ? "" : "s";
  return `${output.row_count} row${plural}${output.truncated ? "+" : ""}`;
};

const stepSummary = (part: ToolPartView) => {
  const input = (part.input ?? {}) as Record<string, unknown>;
  const output = (part.output ?? {}) as Record<string, unknown>;
  switch (part.tool) {
    case "query_data":
      return [input.purpose as string | undefined, rowsLabel(output)];
    case "search_documents":
      return [
        input.query ? `“${input.query}”` : undefined,
        Array.isArray(output.results)
          ? `${output.results.length} matches`
          : undefined,
      ];
    case "get_record":
      return [
        input.type && input.key ? `${input.type} ${input.key}` : undefined,
      ];
    case "check_capacity":
      return [
        input.part_no
          ? `${input.qty} × ${input.part_no} by ${input.due_date}`
          : undefined,
        CAPACITY_ANSWER[String(output.can_take)],
      ];
    case "run_scenario":
      return [input.description as string | undefined];
    case "estimate_quote":
      return [
        input.part_no && Array.isArray(input.qtys)
          ? `${input.qtys.join(" / ")} × ${input.part_no}`
          : undefined,
      ];
    default:
      return [];
  }
};

/** One tool call: what it did, expandable to the details. */
export const ToolStep = ({ part }: { part: ToolPartView }) => {
  const label = TOOL_LABEL[part.tool] ?? {
    icon: BookOpenIcon,
    running: part.tool,
    done: part.tool,
  };
  const running =
    part.state === "input-streaming" || part.state === "input-available";
  const output = (part.output ?? {}) as { error?: string };
  const failed = part.state === "output-error" || Boolean(output.error);
  const Icon = label.icon;
  const sql =
    part.tool === "query_data"
      ? (part.input as { sql?: string })?.sql
      : undefined;
  const summary = stepSummary(part).filter(Boolean).join(" · ");

  return (
    <details className="group text-muted-foreground text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 hover:text-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-open:rotate-90" />
        {running ? <Spinner className="size-3" /> : <Icon className="size-3" />}
        <span className="font-medium">
          {running ? label.running : label.done}
        </span>
        {summary && <span className="truncate">· {summary}</span>}
        {failed && !running && (
          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
            <AlertTriangleIcon className="size-3" /> retried
          </span>
        )}
      </summary>
      <div className="mt-1 ml-4.5 grid gap-1">
        {sql && (
          <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">
            {sql}
          </pre>
        )}
        {(output.error || part.errorText) && (
          <p className="text-amber-700 dark:text-amber-400">
            {output.error ?? part.errorText}
          </p>
        )}
        {!sql && part.input !== undefined && (
          <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">
            {JSON.stringify(part.input, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
};

const compactNumber = (v: number) =>
  v.toLocaleString("en-US", { notation: "compact" });
const CHART_MARGIN = { left: 16, right: 8, top: 8, bottom: 16 };

/** Bar or line chart with stable props (Recharts re-measures axes when props change). */
const ChartArtifact = ({
  title,
  note,
  chart,
}: {
  chart: NonNullable<Artifact["chart"]>;
  note?: string;
  title: string;
}) => {
  const { type, series, points, x_label, y_label } = chart;
  const { keys, config, data, xLabel, yLabel } = useMemo(() => {
    const k = series.map((_, i) => `s${i}`);
    return {
      keys: k,
      config: Object.fromEntries(
        series.map((name, i) => [
          k[i],
          { label: name, color: PALETTE[i % PALETTE.length] },
        ])
      ) as ChartConfig,
      data: points.map((p) => ({
        x: p.x,
        ...Object.fromEntries(k.map((key, i) => [key, p.values[i] ?? 0])),
      })),
      xLabel: { value: x_label, position: "insideBottom" as const, offset: -2 },
      yLabel: { value: y_label, angle: -90, position: "insideLeft" as const },
    };
  }, [series, points, x_label, y_label]);
  const Chart = type === "line" ? LineChart : BarChart;
  return (
    <figure className="my-2 grid gap-2 rounded-xl border p-3">
      <figcaption className="font-medium text-sm">{title}</figcaption>
      <ChartContainer className="aspect-auto h-64 w-full" config={config}>
        <Chart accessibilityLayer data={data} margin={CHART_MARGIN}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="x" label={xLabel} tickLine={false} />
          <YAxis
            label={yLabel}
            tickFormatter={compactNumber}
            tickLine={false}
            width={56}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          {series.length > 1 && (
            <ChartLegend content={<ChartLegendContent />} />
          )}
          {keys.map((k) =>
            type === "line" ? (
              <Line
                dataKey={k}
                dot={false}
                key={k}
                stroke={`var(--color-${k})`}
                strokeWidth={2}
                type="monotone"
              />
            ) : (
              <Bar dataKey={k} fill={`var(--color-${k})`} key={k} radius={4} />
            )
          )}
        </Chart>
      </ChartContainer>
      {note && <p className="text-muted-foreground text-xs">{note}</p>}
    </figure>
  );
};

const PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
];

const fmtCell = (value: string | number | null) => {
  if (value === null) {
    return "—";
  }
  return typeof value === "number" ? value.toLocaleString("en-US") : value;
};

/** A table or chart the agent chose to show. Memoized by content: the parent
 * re-renders on every streamed token, and charts must not re-measure each time. */
export const ArtifactView = memo(
  ({ artifact }: { artifact: Artifact }) => (
    <ArtifactBody artifact={artifact} />
  ),
  (a, b) => JSON.stringify(a.artifact) === JSON.stringify(b.artifact)
);

const ArtifactBody = ({ artifact }: { artifact: Artifact }) => {
  if (artifact.kind === "table" && artifact.table) {
    const { columns, rows } = artifact.table;
    return (
      <figure className="my-2 grid gap-2 rounded-xl border p-3">
        <figcaption className="font-medium text-sm">
          {artifact.title}
        </figcaption>
        <div className="max-h-96 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => (
                  <TableHead key={c}>{c}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no ids
                <TableRow key={i}>
                  {columns.map((c, j) => (
                    <TableCell
                      className={cn(
                        typeof row[j] === "number" && "text-right tabular-nums"
                      )}
                      key={c}
                    >
                      {fmtCell(row[j] ?? null)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {artifact.note && (
          <p className="text-muted-foreground text-xs">{artifact.note}</p>
        )}
      </figure>
    );
  }
  if (artifact.kind === "chart" && artifact.chart) {
    return (
      <ChartArtifact
        chart={artifact.chart}
        note={artifact.note}
        title={artifact.title}
      />
    );
  }
  return null;
};

/** A document passage with the matched words highlighted. */
const Snippet = ({ text }: { text: string }) => (
  <p className="text-muted-foreground leading-relaxed">
    {snippetRuns(text).map((run) =>
      run.match ? (
        <mark
          className="rounded-sm bg-primary/15 px-0.5 text-foreground"
          key={run.start}
        >
          {run.text}
        </mark>
      ) : (
        run.text
      )
    )}
  </p>
);

/** Everything an answer cited, numbered like its footnotes. */
export const SourcesList = ({
  sources,
  numbers,
}: {
  numbers: ReadonlyMap<string, number>;
  sources: Source[];
}) =>
  sources.length === 0 ? null : (
    <details className="group text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-open:rotate-90" />
        {sources.length} source{sources.length === 1 ? "" : "s"}
      </summary>
      <ol className="mt-2 grid gap-2">
        {[...sources]
          .sort((a, b) => (numbers.get(a.id) ?? 0) - (numbers.get(b.id) ?? 0))
          .map((s) => (
            <li className="flex gap-2" key={s.id}>
              <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-muted px-1 font-medium text-muted-foreground">
                {numbers.get(s.id)}
              </span>
              <div className="grid min-w-0 gap-0.5">
                <SourceName source={s} />
                {s.detail && s.kind !== "doc" && (
                  <span className="text-muted-foreground">{s.detail}</span>
                )}
                {s.kind === "doc" && s.detail && <Snippet text={s.detail} />}
                {s.sql && (
                  <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px]">
                    {s.sql}
                  </pre>
                )}
              </div>
            </li>
          ))}
      </ol>
    </details>
  );
