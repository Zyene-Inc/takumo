import "server-only";

import { generateText, type LanguageModelUsage, Output } from "@repo/ai";
import { models } from "@repo/ai/lib/models";
import { z } from "zod";
import type { PlannedOperation } from "./pricing";
import { applyProposal, type CandidatePart } from "./routing";

const schema = z.object({
  operations: z.array(
    z.object({
      workCenter: z.string().describe("A machine name from the shop's list"),
      alternates: z
        .array(z.string())
        .describe("Other shop machines (exact names) that could run this op"),
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
        .describe(
          'Why, in the form "3 threaded holes and a pocket → mill op on HAAS-VF2, like P-2001"'
        ),
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
    /** What was read from the drawing (features, envelope, stock), in lines. */
    drawing?: string | null;
    finish: string | null;
    material: string | null;
    notes: string | null;
    partNo: string | null;
    qty: number;
    tolerances: string | null;
  };
  machines: {
    envelope?: string | null;
    name: string;
    toleranceIn?: number | null;
    type: string | null;
  }[];
}

const SYSTEM = `You are an experienced job-shop estimator. Propose the operations (routing) for a part the shop hasn't made before, based on the most similar parts it has made.

Rules:
- Use only the shop's machines, by exact name. Keep the order the work happens in.
- When the drawing's features are given, let them decide the operations: turned features (diameters, bores, threads on the axis, knurls) → a lathe; prismatic features (pockets, slots, hole patterns) → a mill. Pick machines whose type fits, and whose envelope (when given) holds the part. List other machines that could run each op as alternates.
- reason names the drawing features that need the op, the machine, and the similar part: "3 threaded holes and a pocket → mill op on HAAS-VF2, like P-2001".
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
): Promise<{
  notes: string[];
  ops: PlannedOperation[];
  usage: { modelId: string; tokens: LanguageModelUsage };
}> => {
  const { line } = input;
  const { output, usage, response } = await generateText({
    model: models.agent,
    output: Output.object({ schema }),
    system: SYSTEM,
    prompt: `Shop machines:
${input.machines.map((m) => `- ${m.name}${m.type ? ` (${m.type})` : ""}${m.envelope ? `, holds up to ${m.envelope}` : ""}${m.toleranceIn ? `, holds ±${m.toleranceIn} in` : ""}`).join("\n")}

Similar parts the shop makes, with their routings:
${input.candidates.map(describePart).join("\n\n") || "(none)"}

Part to quote:
- Part: ${line.partNo ?? "not given"}
- Description: ${line.description ?? "not given"}
- Material: ${line.material ?? "not given"}
- Quantity: ${line.qty}
- Tolerances: ${line.tolerances ?? "not given"}
- Finish: ${line.finish ?? "none"}
- Notes: ${line.notes ?? "none"}${line.drawing ? `\n\nRead from the drawing:\n${line.drawing}` : ""}`,
  });
  if (!output) {
    throw new Error("Takumo couldn't propose operations for this part.");
  }
  const { ops, dropped } = applyProposal(
    output.operations,
    input.candidates,
    input.machines.map((m) => m.name)
  );
  return {
    ops,
    notes: [...output.notes.slice(0, 3), ...dropped],
    usage: { modelId: response.modelId, tokens: usage },
  };
};
