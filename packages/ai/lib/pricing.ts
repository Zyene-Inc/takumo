// What Claude calls cost, from Anthropic's list prices (USD per million
// tokens, first-party API, October 2026). Cache writes are the 5-minute TTL
// (1.25× input). Update when prices change. Pure, so tested.

export interface ModelPrice {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
}

export const PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
  },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
  },
};

export interface TokenUsage {
  inputTokenDetails?: {
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
    noCacheTokens?: number | undefined;
  };
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/** Token counts split the way they're billed. */
export const billedTokens = (usage: TokenUsage) => {
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const uncached =
    usage.inputTokenDetails?.noCacheTokens ??
    Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite);
  return { uncached, cacheRead, cacheWrite, output: usage.outputTokens ?? 0 };
};

/** USD for one call; null for a model without a known price. */
export const costUsd = (modelId: string, usage: TokenUsage) => {
  // Provider ids can carry a suffix (e.g. a date); match the known prefix.
  const key = Object.keys(PRICES).find((k) => modelId.startsWith(k));
  if (!key) {
    return null;
  }
  const price = PRICES[key];
  const t = billedTokens(usage);
  return (
    (t.uncached * price.input +
      t.cacheRead * price.cacheRead +
      t.cacheWrite * price.cacheWrite +
      t.output * price.output) /
    1_000_000
  );
};
