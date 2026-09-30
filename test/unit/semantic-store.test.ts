import { describe, it, expect } from "vitest";
import { MemorySemanticStore } from "../../src/cache/semantic-store.js";
import type { ChatCompletionResponse } from "../../src/types/openai.js";

function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function resp(text: string): ChatCompletionResponse {
  return {
    id: "chatcmpl-x",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

describe("MemorySemanticStore", () => {
  it("drops expired rows on write, so write-only buckets stay bounded", async () => {
    const clk = fakeClock();
    const store = new MemorySemanticStore(clk.now);

    await store.add("b", [1, 0, 0], resp("one"), 1); // expires at t=1000
    clk.advance(2000);
    await store.add("b", [0, 1, 0], resp("two"), 1);

    const buckets = (store as unknown as { buckets: Map<string, unknown[]> }).buckets;
    expect(buckets.get("b")!.length).toBe(1);
  });

  it("never serves an expired entry, even before any prune ran", async () => {
    const clk = fakeClock();
    const store = new MemorySemanticStore(clk.now);

    await store.add("b", [1, 0, 0], resp("stale"), 1);
    clk.advance(5000);

    const hit = await store.query("b", [1, 0, 0], 0.9);
    expect(hit).toBeNull();
  });

  it("returns the best live match at or above the threshold", async () => {
    const clk = fakeClock();
    const store = new MemorySemanticStore(clk.now);

    await store.add("b", [0.6, 0.8, 0], resp("close"), 10);
    await store.add("b", [1, 0, 0], resp("exact"), 10);

    const hit = await store.query("b", [1, 0, 0], 0.95);
    expect(hit?.response.choices[0]!.message.content).toBe("exact");
    expect(hit?.similarity).toBeCloseTo(1, 6);
  });
});
