import { describe, it, expect } from "vitest";
import { priceFor, computeCost } from "../../src/accounting/pricing.js";

describe("priceFor", () => {
  it("returns an exact table entry", () => {
    expect(priceFor("gpt-4o-mini")).toEqual({ inputPerMTok: 0.15, outputPerMTok: 0.6 });
  });

  it("uses longest-prefix match for dated variants", () => {
    // "gpt-4o-2024-08-06" should resolve to "gpt-4o", not the shorter "gpt-4".
    expect(priceFor("gpt-4o-2024-08-06")).toEqual({ inputPerMTok: 2.5, outputPerMTok: 10 });
  });

  it("prefers the more specific family prefix", () => {
    // "gpt-4-turbo-2024" starts with both "gpt-4" and "gpt-4-turbo"; pick the longer.
    expect(priceFor("gpt-4-turbo-2024")).toEqual({ inputPerMTok: 10, outputPerMTok: 30 });
  });

  it("falls back to a default price for unknown models", () => {
    expect(priceFor("some-unknown-model")).toEqual({ inputPerMTok: 1, outputPerMTok: 3 });
  });
});

describe("computeCost", () => {
  it("computes input + output cost from token usage", () => {
    // 1M prompt tokens @ $0.15 + 1M completion @ $0.60 = $0.75
    const cost = computeCost("gpt-4o-mini", {
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
      total_tokens: 2_000_000,
    });
    expect(cost).toBeCloseTo(0.75, 10);
  });

  it("scales linearly with token counts", () => {
    const cost = computeCost("gpt-4o-mini", {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
    });
    // 1000/1e6*0.15 + 500/1e6*0.6 = 0.00015 + 0.0003 = 0.00045
    expect(cost).toBeCloseTo(0.00045, 10);
  });

  it("is zero for zero usage", () => {
    expect(
      computeCost("gpt-4o-mini", { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
    ).toBe(0);
  });
});
