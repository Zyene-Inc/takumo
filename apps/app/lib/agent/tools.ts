import "server-only";

import { tool } from "@repo/ai";
import { database, forOrg } from "@repo/database";
import { askQuery, QueryError } from "@repo/database/reader";
import {
  type ScheduleRequest,
  type ScheduleResponse,
  SOLVED_STATUSES,
  schedule,
} from "@repo/engine-client";
import { z } from "zod";
import { featureProblem } from "@/lib/billing";
import {
  ATTRIBUTES,
  attributeDef,
  formatValue,
  parsedValue,
  SUBJECT_TYPES,
} from "@/lib/facts/attributes";
import { findSubject, proposeFact } from "@/lib/facts/facts";
import { searchDocuments } from "@/lib/knowledge/documents";
import { estimateForPart } from "@/lib/quotes/estimate";
import { runCapacityCheck } from "@/lib/schedule/check";
import {
  engineProblem,
  hashFingerprint,
  latestPlan,
  loadShop,
  PLAN_TIME_LIMIT_S,
} from "@/lib/schedule/plan";
import { cite, type Source, sourcesFromRows } from "./citations";
import { getRecordWithKnowledge, RECORD_TYPES } from "./records";
import { describeViews } from "./schema";

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
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const ROUTING_OP = /^(.+) op (\d+)$/;
const DAY_MS = 86_400_000;
const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

const machineLoad = (output: ScheduleResponse, start: string, days: number) => {
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

/** The agent's tools. Results carry `sources` so answers can cite them. */
export const createTools = (
  ctx: AgentContext,
  counters: Counters = {
    queries: 0,
    scenarios: 0,
    estimates: 0,
  }
) => {
  let { queries, scenarios, estimates } = counters;

  return {
    query_data: tool({
      description: `Run one read-only SQL SELECT (Postgres) over this shop's data and get rows back. Use for counts, totals, averages, rankings, lists and comparisons. Only these views exist (no schema prefix needed):
${describeViews()}
Rules: one SELECT or WITH…SELECT; at most 200 rows come back, so aggregate in SQL; round money to 2 decimals; use ILIKE for names. Today is given in the system prompt (current_date is the server's date, so prefer literal dates).`,
      inputSchema: z.object({
        purpose: z
          .string()
          .describe(
            "One short sentence: what this query answers, shown to the user."
          ),
        sql: z
          .string()
          .describe("A single SELECT statement over the views above."),
      }),
      execute: async ({ purpose, sql }) => {
        queries += 1;
        const n = queries;
        try {
          const result = await askQuery(database, ctx.orgId, sql);
          return {
            query: n,
            row_count: result.rows.length,
            truncated: result.truncated,
            columns: result.columns,
            rows: result.rows,
            sources: [
              cite.query(n, purpose, sql),
              ...sourcesFromRows(result.rows),
            ],
          };
        } catch (error) {
          return {
            query: n,
            error:
              error instanceof QueryError ? error.message : "The query failed.",
            hint: "Fix the SQL and try again. Check view and column names in the tool description.",
          };
        }
      },
    }),

    search_documents: tool({
      description:
        "Search the shop's uploaded documents (SOPs, setup sheets, quality manuals, notes, customer specs) by meaning and keywords. Use for how-to, process, spec and policy questions. Returns snippets with document and page.",
      inputSchema: z.object({
        query: z.string().describe("What to look for, in plain words."),
      }),
      execute: async ({ query }) => {
        const hits = await searchDocuments(ctx.orgId, query, 6);
        if (hits.length === 0) {
          const count = await forOrg(database, ctx.orgId).source.count({
            where: { profile: "document" },
          });
          return {
            results: [],
            note:
              count === 0
                ? "No documents have been uploaded yet (Knowledge → Sources)."
                : `None of the ${count} uploaded documents mention this.`,
            sources: [],
          };
        }
        const sources = hits.map((h) =>
          cite.doc(h.sourceName, h.page, h.sourceId, h.snippet)
        );
        return {
          results: hits.map((h, i) => ({
            cite_as: sources[i].id,
            document: h.sourceName,
            page: h.page,
            section: h.heading,
            snippet: h.snippet,
          })),
          sources,
        };
      },
    }),

    get_record: tool({
      description:
        "Look up one record with everything linked to it: a part (routing, orders, quotes), an order (status and where it is in the plan), a machine (rate, hours, calendar, planned load), a customer (orders, quotes, win rate), a quote or a material.",
      inputSchema: z.object({
        type: z.enum(RECORD_TYPES),
        key: z
          .string()
          .describe(
            "Part number, order number, machine name, customer name, quote number or material name."
          ),
      }),
      execute: async ({ type, key }) => {
        const found = await getRecordWithKnowledge(ctx.orgId, type, key);
        return "error" in found ? { ...found, sources: [] } : found;
      },
    }),

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
        const current = await loadShop(
          ctx.orgId,
          plan.input.request.start_date
        );
        const stale =
          hashFingerprint(current.request) !== plan.input.fingerprint;
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
        "Can we take a new order? Plans the shop with and without it and returns: yes/no, the earliest finish without moving other orders, the finish if it went first and which orders would slip, levers (overtime, split lot, alternate machine) with extra cost, and cost and margin. Use for any 'can we take / ship / make X by <date>' question.",
      inputSchema: z.object({
        part_no: z.string(),
        rev: z
          .string()
          .optional()
          .describe("Only if the part has several revs."),
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
        const answer = await runCapacityCheck(
          ctx.orgId,
          ctx.userId,
          ctx.today,
          {
            partId: part.id,
            qty,
            dueDate: due_date,
            price: price ?? null,
            customer: customer ?? null,
          }
        );
        if (!answer.ok) {
          return { error: answer.error, sources: [] };
        }
        const r = answer.result;
        const check = cite.check(answer.input.orderNo);
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

    estimate_quote: tool({
      description:
        "Price and lead time for a part the shop makes, at one or more quantities: cost build-up (machine time at each rate, material and other costs calibrated from what past jobs actually cost), a suggested price at the shop's usual margin with a range, the earliest lead time that doesn't delay any open order, and the most comparable past quotes. Use for 'what should we quote / charge', 'how much for N of X', price breaks. It doesn't create a quote: RFQs are drafted and approved under Quotes.",
      inputSchema: z.object({
        part_no: z.string(),
        rev: z
          .string()
          .optional()
          .describe("Only if the part has several revs."),
        qtys: z
          .array(z.number().int().positive())
          .min(1)
          .max(6)
          .describe("Quantities to price, e.g. [50, 100, 250]."),
        customer: z.string().optional(),
        needed_by: z
          .string()
          .regex(ISO)
          .optional()
          .describe("YYYY-MM-DD, if the user gave a date."),
        target_margin_pct: z
          .number()
          .min(0)
          .max(85)
          .optional()
          .describe("Only if the user asks for a specific margin."),
      }),
      execute: async ({
        part_no,
        rev,
        qtys,
        customer,
        needed_by,
        target_margin_pct,
      }) => {
        const parts = await forOrg(database, ctx.orgId).part.findMany({
          where: {
            partNo: { equals: part_no.trim(), mode: "insensitive" },
            ...(rev ? { rev: { equals: rev, mode: "insensitive" } } : {}),
          },
          select: { id: true, partNo: true, rev: true },
        });
        if (parts.length === 0) {
          return {
            error: `No part "${part_no}" in this shop. A part the shop hasn't made is quoted from an RFQ under Quotes, where Takumo estimates its operations.`,
            sources: [],
          };
        }
        if (parts.length > 1) {
          return {
            error: `${part_no} has several revs (${parts.map((p) => p.rev).join(", ")}). Ask which one.`,
            sources: [],
          };
        }
        const locked = await featureProblem(ctx.orgId, "quotes");
        if (locked) {
          return { error: locked, sources: [] };
        }
        const part = parts[0];
        const result = await estimateForPart(ctx.orgId, part.id, {
          qtys: [...new Set(qtys)],
          customer: customer ?? null,
          requestedDate: needed_by ?? null,
          targetMargin:
            target_margin_pct === undefined ? null : target_margin_pct / 100,
          today: ctx.today,
        });
        if (!result.ok) {
          return { error: result.error, sources: [] };
        }
        estimates += 1;
        counters.estimates = estimates;
        const r = result.response;
        const estimate = cite.estimate(
          estimates,
          `${part.partNo} × ${qtys.join(" / ")}`
        );
        const named = new Set([
          ...r.breaks.flatMap((b) => b.lines.flatMap((l) => l.sources)),
          ...r.margin.sources,
          ...r.comparables.map((c) => `quote ${c.quote_no}`),
        ]);
        return {
          part: `${part.partNo} rev ${part.rev}`,
          quantities: r.breaks.map((b) => ({
            qty: b.qty,
            cost: b.cost,
            unit_cost: b.unit_cost,
            suggested_unit_price: b.unit_price,
            suggested_total: b.price,
            total_range: [b.price_low, b.price_high],
            margin_pct:
              b.margin_pct === null
                ? null
                : Math.round(b.margin_pct * 1000) / 10,
            lead_time_days: b.lead_time_days,
            finishes: b.completion_date,
            meets_needed_by: b.meets_requested,
            cost_lines: b.lines.map((l) => ({
              item: l.label,
              amount: l.amount,
              basis: l.basis,
              cite: l.sources,
            })),
          })),
          margin: r.margin,
          lead_time_note: r.lead_time_note,
          comparable_quotes: r.comparables.slice(0, 4).map((c) => ({
            quote: c.quote_no,
            part: c.part_no,
            customer: c.customer,
            qty: c.qty,
            unit_price: c.unit_price,
            outcome: c.status,
            margin_pct:
              c.margin_pct === null
                ? null
                : Math.round(c.margin_pct * 1000) / 10,
            margin_basis: c.margin_basis,
            why: c.reasons,
          })),
          price_checks: r.checks,
          warnings: r.warnings,
          cannot_price: r.missing,
          cite_as: estimate.id,
          sources: [
            estimate,
            cite.part(part.partNo, part.id),
            ...[...named].flatMap((id) => {
              const [kind, ...rest] = id.split(" ");
              const name = rest.join(" ");
              if (kind === "quote") {
                return [cite.quote(name)];
              }
              if (kind === "machine") {
                return [cite.machine(name)];
              }
              if (kind === "material") {
                return [cite.material(name)];
              }
              const op = name.match(ROUTING_OP);
              return kind === "routing" && op
                ? [cite.routing(op[1], Number(op[2]), part.id)]
                : [];
            }),
          ],
        };
      },
    }),

    propose_fact: tool({
      description: `Record shop knowledge the user tells you, for a supervisor to review: a corrected number ("setup on the OKUMA for P-2001 is really 2 hours") or knowledge in words ("P-2001 chatters above 1,200 rpm"). Nothing changes until it's approved under Knowledge → Facts to review. Attributes by subject type:
${Object.entries(ATTRIBUTES)
  .map(
    ([t, defs]) =>
      `- ${t}: ${defs.map((d) => `${d.key}${d.unit ? ` (${d.unit})` : ""}${d.percent ? " (fraction, 0.9 = 90%)" : ""}`).join(", ")}`
  )
  .join("\n")}
Times in minutes (2 hours → 120). Use attribute "note" for anything that isn't one of the numbers.`,
      inputSchema: z.object({
        subject_type: z.enum(SUBJECT_TYPES),
        part_no: z
          .string()
          .optional()
          .describe("For an operation (routing) or part."),
        rev: z.string().optional(),
        op: z
          .number()
          .int()
          .optional()
          .describe("Operation number, for an operation."),
        machine: z
          .string()
          .optional()
          .describe(
            "For an operation named by its machine, or a machine fact."
          ),
        name: z.string().optional().describe("Material or customer name."),
        attribute: z.string(),
        value: z.union([z.number(), z.string()]),
        evidence: z.string().describe("The user's own words, verbatim."),
      }),
      execute: async (input) => {
        const found = await findSubject(ctx.orgId, input.subject_type, {
          partNo: input.part_no,
          rev: input.rev,
          seq: input.op,
          workCenter: input.subject_type === "routing" ? input.machine : null,
          name:
            input.subject_type === "work_center"
              ? (input.machine ?? input.name)
              : input.name,
        });
        if (!found.ok) {
          return { error: found.error, sources: [] };
        }
        const made = await proposeFact(ctx.orgId, {
          subject: found.subject,
          attribute: input.attribute,
          value: input.value,
          evidence: input.evidence,
          source: "chat",
          statedBy: ctx.userId,
        });
        if (!made.ok) {
          return { error: made.error, sources: [] };
        }
        const def = attributeDef(input.subject_type, input.attribute);
        const fact = cite.fact(made.fact.label, found.subject.label);
        return {
          fact: made.fact.label,
          status: "pending review",
          already_waiting: made.existing,
          about: found.subject.label,
          what: def?.label ?? input.attribute,
          // As stored: "92" for an efficiency reads back as 92%, not 9200%.
          proposed: formatValue(def, parsedValue(def, input.value)),
          note: "Not applied yet: a supervisor approves it under Knowledge → Facts to review.",
          cite_as: fact.id,
          sources: [fact],
        };
      },
    }),

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
        scenarios += 1;
        const n = scenarios;
        const built = await loadShop(ctx.orgId, ctx.today);
        const base: ScheduleRequest = {
          ...built.request,
          time_limit_s: PLAN_TIME_LIMIT_S,
        };
        const names = new Set(
          base.work_centers.map((w) => w.name.toLowerCase())
        );
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

    show_artifact: tool({
      description:
        "Show a table or a chart under your answer. Use a table for lists of more than 5 rows or several columns, a chart to compare values across categories or over time. Only put numbers that came from tool results in it. Don't repeat the same rows in your text.",
      inputSchema: artifactSchema,
      execute: (artifact) =>
        Promise.resolve(
          (artifact.kind === "table" ? artifact.table : artifact.chart)
            ? { shown: true, sources: [] as Source[] }
            : {
                error: `Give the ${artifact.kind} contents.`,
                sources: [] as Source[],
              }
        ),
    }),
  };
};

export type AgentTools = ReturnType<typeof createTools>;
