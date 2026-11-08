import "server-only";

import { tool } from "@repo/ai";
import type { Source } from "../citations";
import { dataTools } from "./data";
import { knowledgeTools } from "./knowledge";
import { quoteTools } from "./quote";
import { scenarioTools } from "./scenario";
import { scheduleTools } from "./schedule";
import {
  type AgentContext,
  artifactSchema,
  type Counters,
  checkedContext,
} from "./shared";

export type { AgentContext, Artifact, Counters } from "./shared";
export { agentContext, artifactSchema } from "./shared";

/** The agent's tools. Results carry `sources` so answers can cite them. */
export const createTools = (
  given: AgentContext,
  counters: Counters = {
    queries: 0,
    scenarios: 0,
    estimates: 0,
  }
) => {
  const ctx = checkedContext(given);
  // Shared by the tools that count their calls (citation numbers, limits).
  const tally = { ...counters };

  return {
    ...dataTools(ctx, tally),
    ...scheduleTools(ctx),
    ...quoteTools(ctx, tally, counters),
    ...knowledgeTools(ctx),
    ...scenarioTools(ctx, tally),
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
