// What-if plans: overtime and downtime.

import "server-only";

import { tool } from "@repo/ai";
import {
  type ScheduleRequest,
  type ScheduleResponse,
  SOLVED_STATUSES,
  schedule,
} from "@repo/engine-client";
import { z } from "zod";
import {
  engineProblem,
  loadShop,
  PLAN_TIME_LIMIT_S,
} from "@/lib/schedule/plan";
import { cite } from "../citations";
import {
  type AgentContext,
  addDays,
  type Counters,
  DAY_MS,
  ISO,
} from "./shared";

export const scenarioTools = (ctx: AgentContext, tally: Counters) => ({
  run_scenario: tool({
    description:
      "What-if on the schedule: re-plan with overtime on some machines and/or machines down for some days, and compare with today's plan (which orders get later or earlier). Nothing is saved.",
    inputSchema: z.object({
      description: z
        .string()
        .describe("The scenario in a few words, shown to the user."),
      overtime: z
        .object({
          machines: z.array(z.string()).min(1),
          extra_percent: z
            .number()
            .min(5)
            .max(100)
            .describe("Extra hours per working day, e.g. 25"),
        })
        .optional(),
      downtime: z
        .array(
          z.object({
            machine: z.string(),
            from: z.string().regex(ISO),
            to: z.string().regex(ISO),
          })
        )
        .optional(),
    }),
    execute: async ({ description, overtime, downtime }) => {
      tally.scenarios += 1;
      const n = tally.scenarios;
      const built = await loadShop(ctx.orgId, ctx.today);
      const base: ScheduleRequest = {
        ...built.request,
        time_limit_s: PLAN_TIME_LIMIT_S,
      };
      const names = new Set(base.work_centers.map((w) => w.name.toLowerCase()));
      const unknown = [
        ...(overtime?.machines ?? []),
        ...(downtime ?? []).map((d) => d.machine),
      ].filter((m) => !names.has(m.toLowerCase()));
      if (unknown.length) {
        return {
          error: `Unknown machine(s): ${unknown.join(", ")}. Machines: ${base.work_centers.map((w) => w.name).join(", ")}.`,
          sources: [],
        };
      }
      if (base.orders.length === 0) {
        return { error: "There are no open orders to plan.", sources: [] };
      }
      const pick = (name: string, list?: string[]) =>
        (list ?? []).some((m) => m.toLowerCase() === name.toLowerCase());
      const factor = 1 + (overtime?.extra_percent ?? 0) / 100;
      const scenario: ScheduleRequest = {
        ...base,
        work_centers: base.work_centers.map((wc) => {
          let next = wc;
          if (pick(wc.name, overtime?.machines)) {
            next = {
              ...next,
              hours_per_day: Math.min(24, next.hours_per_day * factor),
              exceptions: (next.exceptions ?? []).map((e) => ({
                ...e,
                hours: Math.min(24, e.hours * factor),
              })),
            };
          }
          for (const d of downtime ?? []) {
            if (d.machine.toLowerCase() === wc.name.toLowerCase()) {
              const days: { date: string; hours: number; reason: string }[] =
                [];
              for (
                let day = d.from;
                day <= d.to && days.length < 120;
                day = addDays(day, 1)
              ) {
                days.push({
                  date: day,
                  hours: 0,
                  reason: "scenario downtime",
                });
              }
              const others = (next.exceptions ?? []).filter(
                (e) => !days.some((x) => x.date === e.date)
              );
              next = { ...next, exceptions: [...others, ...days] };
            }
          }
          return next;
        }),
      };
      let before: ScheduleResponse;
      let after: ScheduleResponse;
      try {
        [before, after] = await Promise.all([
          schedule(base),
          schedule(scenario),
        ]);
      } catch (error) {
        return { error: engineProblem(error), sources: [] };
      }
      if (
        !(
          SOLVED_STATUSES.includes(before.status) &&
          SOLVED_STATUSES.includes(after.status)
        )
      ) {
        return {
          error: `The scheduler couldn't plan it (${after.status}).`,
          sources: [],
        };
      }
      const was = new Map(before.orders.map((o) => [o.order_no, o]));
      const changes = after.orders
        .map((o) => {
          const old = was.get(o.order_no);
          const shift = old
            ? (Date.parse(o.completion_date) -
                Date.parse(old.completion_date)) /
              DAY_MS
            : 0;
          return {
            order_no: o.order_no,
            due: o.due_date,
            finishes_now: old?.completion_date ?? null,
            finishes_in_scenario: o.completion_date,
            days_later: shift,
            days_late_now: old?.days_late ?? 0,
            days_late_in_scenario: o.days_late,
          };
        })
        .filter(
          (c) =>
            c.days_later !== 0 || c.days_late_now !== c.days_late_in_scenario
        );
      const scenarioSource = cite.scenario(n, description);
      return {
        scenario: n,
        description,
        late_orders_now: before.orders.filter((o) => o.days_late > 0).length,
        late_orders_in_scenario: after.orders.filter((o) => o.days_late > 0)
          .length,
        total_days_late_now: before.total_days_late,
        total_days_late_in_scenario: after.total_days_late,
        orders_that_change: changes,
        cite_as: scenarioSource.id,
        sources: [
          scenarioSource,
          ...changes.map((c) => cite.order(c.order_no)),
        ],
      };
    },
  }),
});
