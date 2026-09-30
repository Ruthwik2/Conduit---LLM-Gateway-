import type { TokenUsage } from "../types/openai.js";

/** Price in USD per 1,000,000 tokens, split by direction. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Illustrative list prices (USD per 1M tokens). These are deliberately editable
 * defaults, not a live price feed — operators should keep them in sync with
 * their providers' current rates. Lookup is longest-prefix so dated model
 * variants (e.g. "gpt-4o-2024-08-06") inherit their family's price.
 */
const PRICES: Record<string, ModelPrice> = {
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
  "gpt-4-turbo": { inputPerMTok: 10, outputPerMTok: 30 },
  "gpt-4": { inputPerMTok: 30, outputPerMTok: 60 },
  "gpt-3.5-turbo": { inputPerMTok: 0.5, outputPerMTok: 1.5 },
  "claude-3-5-haiku": { inputPerMTok: 0.8, outputPerMTok: 4 },
  "claude-3-5-sonnet": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-3-7-sonnet": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-3-opus": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-3-haiku": { inputPerMTok: 0.25, outputPerMTok: 1.25 },
  "text-embedding-3-small": { inputPerMTok: 0.02, outputPerMTok: 0 },
  "text-embedding-3-large": { inputPerMTok: 0.13, outputPerMTok: 0 },
  // Synthetic prices so the offline mock/demo path still produces visible spend.
  "demo-model": { inputPerMTok: 1, outputPerMTok: 3 },
  "mock-model": { inputPerMTok: 1, outputPerMTok: 3 },
};

/** Fallback when a model isn't in the table — priced like a mid-tier model. */
const DEFAULT_PRICE: ModelPrice = { inputPerMTok: 1, outputPerMTok: 3 };

export function priceFor(model: string): ModelPrice {
  if (PRICES[model]) return PRICES[model]!;
  // Longest-prefix match: pick the most specific family key the model starts with.
  let best: ModelPrice | null = null;
  let bestLen = -1;
  for (const [prefix, price] of Object.entries(PRICES)) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = price;
      bestLen = prefix.length;
    }
  }
  return best ?? DEFAULT_PRICE;
}

/** Cost in USD for a completed call, given the model and its token usage. */
export function computeCost(model: string, usage: TokenUsage): number {
  const price = priceFor(model);
  const input = (usage.prompt_tokens / 1_000_000) * price.inputPerMTok;
  const output = (usage.completion_tokens / 1_000_000) * price.outputPerMTok;
  return input + output;
}
