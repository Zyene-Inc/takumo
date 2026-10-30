import "server-only";

import { generateText, Output } from "@repo/ai";
import { models } from "@repo/ai/lib/models";
import type { QuoteOperation } from "@repo/engine-client/types";
import { z } from "zod";
import { applyProposal, type CandidatePart } from "./routing";

const schema = z.object({
  operations: z.array(
    z.object({
      workCenter: z.string().describe("A machine name from the shop's list"),
      basisPartNo: z
        .string()
        .nullable()
        .describe("The similar part whose operation this is based on"),
      basisSeq: z.number().int().nullable().describe("That part's op number"),
      setupScale: z
        .number()
        .nullable()
        .describe("Setup time vs the basis operation, e.g. 1.2 = 20% longer"),
      runScale: z
        .number()
        .nullable()
        .describe("Run time per part vs the basis operation"),
      setupMin: z
        .number()
        .nullable()
        .describe("Only when no basis operation fits: setup minutes"),
      runMinPerUnit: z
        .number()
        .nullable()
        .describe("Only when no basis operation fits: run minutes per part"),
      reason: z
        .string()
        .describe("One short sentence: why this machine and these times"),
    })
  ),
  notes: z
    .array(z.string())
    .describe("At most 3 things the estimator should check"),
});

export interface ProposeInput {
  candidates: CandidatePart[];
  line: {
    description: string | null;
    finish: string | null;
    material: string | null;
    notes: string | null;
    partNo: string | null;
    qty: number;
    tolerances: string | null;
  };
  machines: { name: string; type: string | null }[];
}

const SYSTEM = `You are an experienced job-shop estimator. Propose the operations (routing) for a part the shop hasn't made before, based on the most similar parts it has made.

Rules:
- Use only the shop's machines, by exact name. Keep the order the work happens in.
- Base each operation on one operation of a similar part (basisPartNo + basisSeq), and scale its setup and run time by a factor (0.25–4) for size, complexity and material differences. Say why in reason.
- Only when no similar operation fits at all, give setupMin and runMinPerUnit yourself and leave the basis null.
- Don't add operations for outside processes (anodize, plating, heat treat): those are priced separately.
- notes: what the estimator should check (e.g. "Tolerance ±0.0005 may need a grinding op the shop doesn't have").`;

const describePart = (p: CandidatePart) =>
  `${p.partNo} rev ${p.rev}: ${p.description ?? "no description"}; material ${p.material ?? "unknown"}; customer ${p.customer ?? "unknown"}
${p.routing.map((r) => `  op ${r.seq} ${r.work_center}: ${r.setup_min} min setup, ${r.run_min_per_unit} min/part`).join("\n")}`;

/** Ask Claude for a routing; returns operations with their basis, and notes. */
export const proposeRouting = async (
  input: ProposeInput
): Promise<{ ops: QuoteOperation[]; notes: string[] }> => {
  const { line } = input;
  const { output } = await generateText({
    model: models.agent,
    output: Output.object({ schema }),
    system: SYSTEM,
    prompt: `Shop machines:
${input.machines.map((m) => `- ${m.name}${m.type ? ` (${m.type})` : ""}`).join("\n")}

Similar parts the shop makes, with their routings:
${input.candidates.map(describePart).join("\n\n") || "(none)"}

Part to quote:
- Part: ${line.partNo ?? "not given"}
- Description: ${line.description ?? "not given"}
- Material: ${line.material ?? "not given"}
- Quantity: ${line.qty}
- Tolerances: ${line.tolerances ?? "not given"}
- Finish: ${line.finish ?? "none"}
- Notes: ${line.notes ?? "none"}`,
  });
  if (!output) {
    throw new Error("Takumo couldn't propose operations for this part.");
  }
  const { ops, dropped } = applyProposal(
    output.operations,
    input.candidates,
    input.machines.map((m) => m.name)
  );
  return { ops, notes: [...output.notes.slice(0, 3), ...dropped] };
};
