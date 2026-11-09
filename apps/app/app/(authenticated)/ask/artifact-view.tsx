"use client";

import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/design-system/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { cn } from "@repo/design-system/lib/utils";
import { memo, useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import type { Artifact } from "@/lib/agent/tools";

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
