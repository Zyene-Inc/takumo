// Pricing a part the shop makes.

import "server-only";

import { tool } from "@repo/ai";
import { database, forOrg } from "@repo/database";
import { z } from "zod";
import { featureProblem } from "@/lib/billing";
import { estimateForPart } from "@/lib/quotes/estimate";
import { cite } from "../citations";
import { type AgentContext, type Counters, ISO, ROUTING_OP } from "./shared";

export const quoteTools = (
  ctx: AgentContext,
  tally: Counters,
  counters: Counters
) => ({
  estimate_quote: tool({
    description:
      "Price and lead time for a part the shop makes, at one or more quantities: cost build-up (machine time at each rate, material and other costs calibrated from what past jobs actually cost), a suggested price at the shop's usual margin with a range, the earliest lead time that doesn't delay any open order, and the most comparable past quotes. Use for 'what should we quote / charge', 'how much for N of X', price breaks. It doesn't create a quote: RFQs are drafted and approved under Quotes.",
    inputSchema: z.object({
      part_no: z.string(),
      rev: z.string().optional().describe("Only if the part has several revs."),
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
      tally.estimates += 1;
      counters.estimates = tally.estimates;
      const r = result.response;
      const estimate = cite.estimate(
        tally.estimates,
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
            b.margin_pct === null ? null : Math.round(b.margin_pct * 1000) / 10,
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
            c.margin_pct === null ? null : Math.round(c.margin_pct * 1000) / 10,
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
});
