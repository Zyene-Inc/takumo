// Reading the shop: SQL over its data, document search and single records.

import "server-only";

import { tool } from "@repo/ai";
import { database, forOrg } from "@repo/database";
import { askQuery, QueryError } from "@repo/database/reader";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { searchDocuments } from "@/lib/knowledge/documents";
import { cite, sourcesFromRows } from "../citations";
import { getRecordWithKnowledge, RECORD_TYPES } from "../records";
import { describeViews } from "../schema";
import type { AgentContext, Counters } from "./shared";

const SQL_HINT =
  "Fix the SQL and try again. Check view and column names in the tool description.";
const OFF_HINT =
  "Don't call query_data again in this answer. Use get_record, get_schedule or the other tools, or tell the person that totals, counts and lists aren't available right now.";

/**
 * What the agent sees when a query didn't run. QueryError messages never
 * quote the database (reader.ts); anything else is answered in general terms.
 * The log keeps the reference and SQLSTATE only: not the SQL, not a message
 * that could quote a row.
 */
const queryFailed = (orgId: string, n: number, error: unknown) => {
  if (!(error instanceof QueryError)) {
    log.error("Ask data query failed", {
      orgId,
      name: String((error as Error)?.name),
    });
    return { query: n, error: "The query failed.", hint: SQL_HINT };
  }
  if (error.stage === "plan" || error.stage === "run") {
    log.warn("Ask data query failed", {
      orgId,
      ref: error.ref,
      sqlState: error.sqlState,
      stage: error.stage,
    });
  }
  return {
    query: n,
    error: error.message,
    hint: error.stage === "off" ? OFF_HINT : SQL_HINT,
  };
};

export const dataTools = (ctx: AgentContext, tally: Counters) => ({
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
      tally.queries += 1;
      const n = tally.queries;
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
        return queryFailed(ctx.orgId, n, error);
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
});
