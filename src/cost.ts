export interface TokenPrices {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface CostSnapshot {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  estimatedUsd: number;
}

export interface CostTracker extends CostSnapshot {
  add(inputTokens: number, outputTokens: number): void;
}

export function estimateUsd(inputTokens: number, outputTokens: number, prices: TokenPrices): number {
  return (inputTokens / 1_000_000) * prices.inputPerMillion + (outputTokens / 1_000_000) * prices.outputPerMillion;
}

export function createCostTracker(prices: TokenPrices): CostTracker {
  return {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    estimatedUsd: 0,
    add(inputTokens: number, outputTokens: number) {
      this.inputTokens += inputTokens;
      this.outputTokens += outputTokens;
      this.calls += 1;
      this.estimatedUsd = estimateUsd(this.inputTokens, this.outputTokens, prices);
    },
  };
}

export function emptyCost(): CostSnapshot {
  return { inputTokens: 0, outputTokens: 0, calls: 0, estimatedUsd: 0 };
}

export function assertWithinBudget(cost: CostSnapshot, maxCostUsd: number | null): void {
  if (maxCostUsd == null) return;
  if (cost.estimatedUsd > maxCostUsd) {
    throw new Error(
      `LLM cost estimate $${cost.estimatedUsd.toFixed(4)} exceeds llm.max_cost_usd (${maxCostUsd}). The digest was not posted.`,
    );
  }
}
