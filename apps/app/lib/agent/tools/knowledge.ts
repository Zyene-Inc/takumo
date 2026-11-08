// Proposing a fact for a supervisor to review.

import "server-only";

import { tool } from "@repo/ai";
import { z } from "zod";
import {
  ATTRIBUTES,
  attributeDef,
  formatValue,
  parsedValue,
  SUBJECT_TYPES,
} from "@/lib/facts/attributes";
import { findSubject, proposeFact } from "@/lib/facts/facts";
import { cite } from "../citations";
import type { AgentContext } from "./shared";

export const knowledgeTools = (ctx: AgentContext) => ({
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
        .describe("For an operation named by its machine, or a machine fact."),
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
        viewer: ctx.viewer,
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
});
