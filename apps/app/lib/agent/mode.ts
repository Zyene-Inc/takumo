import "server-only";

import { generateText, Output } from "@repo/ai";
import { models } from "@repo/ai/lib/models";
import { z } from "zod";
import { recordFailedUsage, recordUsage } from "@/lib/ai-usage";
import { type AnswerMode, hintedMode } from "./answer";

// Quick questions (look-ups, lists, simple counts) run on the chat model, about
// a third of the agent model's price. Anything that plans, prices or compares
// runs on the agent model. Ask Takumo has an override for both.

const schema = z.object({ mode: z.enum(["quick", "thorough"]) });

const SYSTEM = `You route questions for a job shop's operations assistant. Answer "quick" when one or two look-ups answer it: a record's details, a list, a status, a simple count or total, what a document says. Answer "thorough" when it needs planning, pricing, capacity or what-if checks, comparing several things, judgment or recommendations, several steps, or when you're unsure.`;

/**
 * Picks the model for a question in Auto mode. Falls back to thorough on any
 * error: a slower answer beats a wrong one.
 */
export const chooseMode = async (
  orgId: string,
  userId: string,
  question: string,
  /** The previous answer, so "and for 500?" is read in context. */
  previous?: string
): Promise<AnswerMode> => {
  const hinted = hintedMode(question);
  if (hinted) {
    return hinted;
  }
  try {
    const { output, usage, response } = await generateText({
      model: models.extract,
      output: Output.object({ schema }),
      system: SYSTEM,
      prompt: `${previous ? `Previous answer (for context):\n${previous.slice(0, 600)}\n\n` : ""}Question: ${question.slice(0, 1000)}`,
      maxOutputTokens: 50,
    });
    await recordUsage(orgId, "ask", response.modelId, usage, userId);
    return output?.mode ?? "thorough";
  } catch (error) {
    await recordFailedUsage(orgId, "ask", error);
    return "thorough";
  }
};
