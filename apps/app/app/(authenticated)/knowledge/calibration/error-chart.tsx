"use client";

import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@repo/design-system/components/ui/chart";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import type { WeekError } from "@/lib/facts/calibration";

const config = {
  setup: { label: "Setup time error", color: "var(--chart-1)" },
  run: { label: "Run time error", color: "var(--chart-2)" },
} satisfies ChartConfig;

const pct = (value: number) => `${Math.round(value)}%`;

/** Weekly model error: how far planned times were from actual times. */
export const ErrorChart = ({ weeks }: { weeks: WeekError[] }) => {
  const data = weeks.map((w) => ({
    week: w.week.slice(5),
    setup: w.setupError === null ? null : Math.round(w.setupError * 1000) / 10,
    run: w.runError === null ? null : Math.round(w.runError * 1000) / 10,
  }));
  return (
    <ChartContainer className="aspect-auto h-64 w-full" config={config}>
      <LineChart
        accessibilityLayer
        data={data}
        margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis dataKey="week" tickLine={false} />
        <YAxis tickFormatter={pct} tickLine={false} width={44} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(v, name) =>
                `${config[name as keyof typeof config]?.label ?? name}: ${v}%`
              }
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Line
          connectNulls
          dataKey="setup"
          dot
          stroke="var(--color-setup)"
          strokeWidth={2}
          type="monotone"
        />
        <Line
          connectNulls
          dataKey="run"
          dot
          stroke="var(--color-run)"
          strokeWidth={2}
          type="monotone"
        />
      </LineChart>
    </ChartContainer>
  );
};
