// The plan and capacity checks.

import "server-only";

import { tool } from "@repo/ai";
import { database, forOrg } from "@repo/database";
import { z } from "zod";
import { runCapacityCheck } from "@/lib/schedule/check";
import { hashFingerprint, latestPlan, loadShop } from "@/lib/schedule/plan";
import { cite, type Source } from "../citations";
import { type AgentContext, DAY_MS, ISO, machineLoad } from "./shared";

export const scheduleTools = (ctx: AgentContext) => ({
  get_schedule: tool({
    description:
      "The current production plan: when it was made, which orders are late or tight, and how loaded each machine is over the next 7 and 14 days (the bottleneck first).",
    inputSchema: z.object({}),
    execute: async () => {
      const plan = await latestPlan(ctx.orgId);
      if (!plan) {
        return {
          error:
            "There's no plan yet. A planner builds it on Schedule → Board.",
          sources: [],
        };
      }
      const current = await loadShop(ctx.orgId, plan.input.request.start_date);
      const stale = hashFingerprint(current.request) !== plan.input.fingerprint;
      const start = plan.input.request.start_date;
      const results = plan.output.orders;
      const late = results
        .filter((o) => o.days_late > 0)
        .sort((a, b) => b.days_late - a.days_late);
      const tight = results.filter((o) => {
        const slack =
          (Date.parse(o.due_date) - Date.parse(o.completion_date)) / DAY_MS;
        return o.days_late === 0 && slack <= 1;
      });
      const week = machineLoad(plan.output, start, 7);
      const sources: Source[] = [
        cite.plan(),
        ...[...late, ...tight].map((o) => cite.order(o.order_no)),
        ...week.map((m) => cite.machine(m.machine)),
      ];
      return {
        planned_at: plan.createdAt.toISOString(),
        plan_starts: start,
        quality: plan.output.status,
        out_of_date: stale,
        orders_in_plan: results.length,
        on_time: results.length - late.length,
        late_orders: late.map((o) => ({
          order_no: o.order_no,
          due: o.due_date,
          finishes: o.completion_date,
          days_late: o.days_late,
        })),
        tight_orders: tight.map((o) => ({
          order_no: o.order_no,
          due: o.due_date,
          finishes: o.completion_date,
        })),
        not_scheduled: plan.input.skipped,
        load_next_7_days: week,
        load_next_14_days: machineLoad(plan.output, start, 14),
        sources,
      };
    },
  }),

  check_capacity: tool({
    description:
      "Can we take a new order? Plans the shop with and without it, counting machine hours, the operators on shift who are qualified on each machine (and their time off), and when the material is ready (stock, open POs, lead time). Returns: yes/no, the earliest finish without moving other orders, the finish if it went first and which orders would slip, levers (overtime, split lot, alternate machine, another qualified operator, expediting the material) with extra cost, and cost and margin. The summary names the reason for a no in plain words (a machine short of people on a shift, material arriving later). Use for any 'can we take / ship / make X by <date>' question.",
    inputSchema: z.object({
      part_no: z.string(),
      rev: z.string().optional().describe("Only if the part has several revs."),
      qty: z.number().int().positive(),
      due_date: z.string().regex(ISO).describe("YYYY-MM-DD"),
      price: z
        .number()
        .positive()
        .optional()
        .describe("Order price in USD, if the user gave one."),
      customer: z.string().optional(),
    }),
    execute: async ({ part_no, rev, qty, due_date, price, customer }) => {
      const parts = await forOrg(database, ctx.orgId).part.findMany({
        where: {
          partNo: { equals: part_no.trim(), mode: "insensitive" },
          ...(rev ? { rev: { equals: rev, mode: "insensitive" } } : {}),
        },
        select: {
          id: true,
          partNo: true,
          rev: true,
          routings: { select: { setupMin: true, runMinPerUnit: true } },
        },
      });
      if (parts.length === 0) {
        return { error: `No part "${part_no}" in this shop.`, sources: [] };
      }
      if (parts.length > 1) {
        return {
          error: `${part_no} has several revs (${parts.map((p) => p.rev).join(", ")}). Ask which one.`,
          sources: [],
        };
      }
      const part = parts[0];
      const answer = await runCapacityCheck(ctx.orgId, ctx.userId, ctx.today, {
        partId: part.id,
        qty,
        dueDate: due_date,
        price: price ?? null,
        customer: customer ?? null,
      });
      if (!answer.ok) {
        return { error: answer.error, sources: [] };
      }
      const r = answer.result;
      const check = cite.check(answer.input.orderNo, answer.runId);
      return {
        can_take: r.can_take,
        summary: r.explanation,
        due: due_date,
        // Nominal routing time for the job (setup + run × qty).
        machine_hours:
          Math.round(
            part.routings.reduce(
              (sum, op) => sum + op.setupMin + op.runMinPerUnit * qty,
              0
            ) / 6
          ) / 10,
        earliest_without_moving_others: r.new_order,
        if_it_goes_first: r.rush,
        orders_that_would_slip: r.slipped,
        levers: r.levers,
        cost: r.cost,
        // Opens this answer with "Add to plan" (Takumo's plan only).
        add_to_plan_link: check.href,
        cite_as: check.id,
        sources: [
          check,
          cite.part(part.partNo, part.id),
          cite.plan(),
          ...r.slipped.map((s) => cite.order(s.order_no)),
        ],
      };
    },
  }),
});
