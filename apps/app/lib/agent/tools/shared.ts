// Types and helpers the agent's tools share.

import "server-only";
import type { ScheduleResponse } from "@repo/engine-client";
import { z } from "zod";
import { trustedViewer, type Viewer } from "@/lib/library/viewer";

/** Numbering for [query n], [scenario n] and [estimate n] within a conversation. */
export interface Counters {
  estimates: number;
  queries: number;
  scenarios: number;
}

export interface AgentContext {
  orgId: string;
  /** Local date (YYYY-MM-DD) the user is asking on. */
  today: string;
  userId: string | null;
  /**
   * Who is asking, made on the server. Every tool reads documents and facts
   * as this person (lib/library/ai-access.ts); orgId and userId are theirs.
   */
  viewer: Viewer;
}

/** The agent's context for a viewer made on the server. */
export const agentContext = (viewer: Viewer, today: string): AgentContext => {
  const trusted = trustedViewer(viewer);
  return {
    orgId: trusted.orgId,
    userId: trusted.userId,
    viewer: trusted,
    today,
  };
};

/** The context, when its shop and user are its viewer's; throws otherwise. */
export const checkedContext = (ctx: AgentContext): AgentContext => {
  const viewer = trustedViewer(ctx.viewer);
  if (viewer.orgId !== ctx.orgId || viewer.userId !== ctx.userId) {
    throw new Error("The agent's context doesn't match who is asking.");
  }
  return ctx;
};

export const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const ROUTING_OP = /^(.+) op (\d+)$/;
export const DAY_MS = 86_400_000;
export const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

export const machineLoad = (
  output: ScheduleResponse,
  start: string,
  days: number
) => {
  const end = addDays(start, days);
  const totals = new Map<string, { used: number; capacity: number }>();
  for (const d of output.load) {
    if (d.date < end) {
      const t = totals.get(d.work_center) ?? { used: 0, capacity: 0 };
      t.used += d.load_minutes;
      t.capacity += d.capacity_minutes;
      totals.set(d.work_center, t);
    }
  }
  return [...totals.entries()]
    .map(([machine, t]) => ({
      machine,
      planned_hours: Math.round(t.used / 6) / 10,
      utilization_pct: t.capacity ? Math.round((t.used / t.capacity) * 100) : 0,
    }))
    .sort((a, b) => b.utilization_pct - a.utilization_pct);
};

/** A table or chart under the answer (one top-level object: the model API needs that). */
export const artifactSchema = z.object({
  kind: z.enum(["table", "chart"]),
  title: z.string(),
  note: z.string().optional(),
  table: z
    .object({
      columns: z.array(z.string()).min(1).max(10),
      rows: z
        .array(z.array(z.union([z.string(), z.number(), z.null()])))
        .max(200),
    })
    .optional()
    .describe("For kind 'table'."),
  chart: z
    .object({
      type: z.enum(["bar", "line"]),
      x_label: z.string(),
      y_label: z.string(),
      series: z
        .array(z.string())
        .min(1)
        .max(4)
        .describe("Series names, e.g. ['Revenue']"),
      points: z
        .array(z.object({ x: z.string(), values: z.array(z.number()) }))
        .min(1)
        .max(60)
        .describe(
          "One point per category or date; values line up with series."
        ),
    })
    .optional()
    .describe("For kind 'chart'."),
});

export type Artifact = z.infer<typeof artifactSchema>;
