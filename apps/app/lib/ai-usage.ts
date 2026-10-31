import "server-only";

import { billedTokens, costUsd, type TokenUsage } from "@repo/ai/lib/pricing";
import { database } from "@repo/database";
import { log } from "@repo/observability/log";
import { env } from "@/env";

export type AiFeature = "ask" | "rfq_read" | "routing_proposal" | "note_read";

/** Record what a Claude call used. Never throws: spend tracking can't break a request. */
export const recordUsage = async (
  orgId: string,
  feature: AiFeature,
  modelId: string,
  usage: TokenUsage,
  userId: string | null = null
) => {
  try {
    const t = billedTokens(usage);
    const cost = costUsd(modelId, usage);
    if (cost === null) {
      log.warn("No price for model; AI spend not counted", { modelId });
    }
    await database.aiUsage.create({
      data: {
        orgId,
        userId,
        feature,
        model: modelId,
        inputTokens: t.uncached,
        cacheReadTokens: t.cacheRead,
        cacheWriteTokens: t.cacheWrite,
        outputTokens: t.output,
        costUsd: cost ?? 0,
      },
    });
  } catch (error) {
    log.warn("Recording AI usage failed", {
      orgId,
      feature,
      error: String(error),
    });
  }
};

const monthStart = (now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** A shop's AI spend this calendar month (UTC), in USD. */
export const monthSpend = async (orgId: string, now = new Date()) => {
  const sum = await database.aiUsage.aggregate({
    where: { orgId, createdAt: { gte: monthStart(now) } },
    _sum: { costUsd: true },
  });
  return Number(sum._sum.costUsd ?? 0);
};

/** The monthly cap per shop, or null when there isn't one. */
export const monthlyBudget = () => {
  const value = Number(env.AI_MONTHLY_BUDGET_USD);
  return Number.isFinite(value) && value > 0 ? value : null;
};

/** Why AI features are paused for this shop (its cap is spent), or null. */
export const budgetProblem = async (orgId: string) => {
  const budget = monthlyBudget();
  if (budget === null) {
    return null;
  }
  return (await monthSpend(orgId)) >= budget
    ? "This shop has used its AI allowance for the month. It resets on the 1st; contact Takumo support to raise it sooner."
    : null;
};
